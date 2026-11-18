import { afterAll, beforeEach, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Context, Message, Model, StreamEvent, ToolDef } from '../src/llm.js'
import type * as Llm from '../src/llm.js'
import { reflect, reflectionTranscript, createEvolution } from '../src/evolution.js'
import { listReflections } from '../src/evolution-files.js'

const fixture = vi.hoisted(() => ({ dir: '' }))
const { stream } = vi.hoisted(() => ({ stream: vi.fn<(model: Model, context: Context, opts: { tools?: ToolDef[]; signal?: AbortSignal }) => AsyncGenerator<StreamEvent>>() }))
vi.mock('node:os', async (load) => {
  const actual = await load<typeof os>()
  fixture.dir = await fs.realpath(await fs.mkdtemp(actual.tmpdir() + '/minipi-evolution-'))
  return { ...actual, homedir: () => fixture.dir }
})
vi.mock('../src/llm.js', async (load) => ({ ...await load<typeof Llm>(), stream }))

const model: Model = { apiKey: 'test', model: 'test' }
const cwd = path.join(fixture.dir, 'project')
const file = path.join(cwd, 'report.md')
const messages: Message[] = [{ role: 'user', content: '请补写报告' }, { role: 'assistant', content: '尚未保存报告' }]
async function* write(): AsyncGenerator<StreamEvent> {
  yield { type: 'tool_call', id: 'w', name: 'write_file', args: { path: 'report.md', content: '完成' } }
  yield { type: 'done', stopReason: 'tool_use' }
}

beforeEach(async () => {
  vi.restoreAllMocks()
  stream.mockReset().mockImplementation(async function* () {
    yield { type: 'text_delta', delta: '已补写报告。' }
    yield { type: 'done', stopReason: 'end_turn' }
  })
  await fs.rm(fixture.dir, { recursive: true, force: true })
  await fs.mkdir(cwd, { recursive: true })
})
afterAll(async () => { await fs.rm(fixture.dir, { recursive: true, force: true }) })

it('selects only conversational text, excludes its own notifications and limits the recent tail', () => {
  expect(reflectionTranscript([
    ...messages,
    { role: 'system', section: 'preferences', content: 'not transcript' },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: 'not transcript' }] },
    { role: 'assistant', content: '[EVOLUTION] previous review' },
    { role: 'assistant', content: [{ type: 'text', text: 'ordinary reply' }, { type: 'tool_use', id: '1', name: 'edit', input: {} }] },
  ])).toBe('user: 请补写报告\nassistant: 尚未保存报告\nassistant: ordinary reply')
  const long = reflectionTranscript([{ role: 'user', content: 'old' + 'x'.repeat(13000) + 'recent' }])
  expect(long).not.toContain('old')
  expect(long.endsWith('recent')).toBe(true)
  expect(long.length).toBeLessThan(12100)
})

it('runs an isolated agent with restricted tools and returns only committed changes', async () => {
  stream.mockImplementationOnce(write)
  const source = structuredClone(messages)
  const result = await reflect(model, source, cwd)
  expect(result?.summary).toBe('已补写报告。')
  expect(await fs.readFile(file, 'utf8')).toBe('完成')
  expect(source).toEqual(messages)
  expect(stream.mock.calls[0][2].tools?.map(tool => tool.name)).toEqual(['read_file', 'write_file', 'edit', 'list_files'])
  expect(await listReflections(cwd)).toEqual([result])
})

it.each(['[SILENT]', '', '...', 'truncated', 'error'])('restores writes when the final response is unusable: %s', async (ending) => {
  await fs.writeFile(file, 'original')
  stream.mockImplementationOnce(write).mockImplementationOnce(async function* () {
    if (ending === 'error') { yield { type: 'error', error: new Error('network error') }; return }
    yield { type: 'text_delta', delta: ending }
    yield { type: 'done', stopReason: ending === 'truncated' ? 'max_tokens' : 'end_turn' }
  })
  if (ending === '[SILENT]') expect(await reflect(model, messages, cwd)).toBeNull()
  else await expect(reflect(model, messages, cwd)).rejects.toThrow()
  expect(await fs.readFile(file, 'utf8')).toBe('original')
  expect(await listReflections(cwd)).toEqual([])
})

it('stops after twelve requests and rolls back a model that keeps calling tools', async () => {
  stream.mockImplementation(write)
  await expect(reflect(model, messages, cwd)).rejects.toThrow('12 轮')
  expect(stream).toHaveBeenCalledTimes(12)
  await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('uses incremental text, does not rereview its own notice, and resets after compaction', async () => {
  const context: Context = { messages: [...messages] }
  const evolution = createEvolution(model, context, cwd, async record => {
    context.messages.push({ role: 'assistant', content: '[EVOLUTION] ' + record.id })
  })
  stream.mockImplementationOnce(write)
  await evolution.run()
  await evolution.run()
  expect(stream).toHaveBeenCalledTimes(2)
  context.messages.push({ role: 'user', content: '新增纠正' })
  await evolution.run()
  expect(stream.mock.calls[2][1].messages[0].content).toContain('新增纠正')
  expect(stream.mock.calls[2][1].messages[0].content).not.toContain('请补写报告')
  context.messages = [{ role: 'user', content: '[context summary] 压缩后的纠正' }]
  await evolution.run()
  expect(stream.mock.calls[3][1].messages[0].content).toContain('压缩后的纠正')
})

it('requires idle time and six completed user turns or context pressure, and skips a busy foreground', async () => {
  let now = 1_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const context: Context = { messages: [...messages] }
  const evolution = createEvolution(model, context, cwd, vi.fn())
  for (let i = 0; i < 5; i++) { await evolution.beginTurn(); evolution.endTurn(true) }
  now += 600_000
  await evolution.tick()
  expect(stream).not.toHaveBeenCalled()
  await evolution.beginTurn()
  now += 600_000
  await evolution.tick()
  expect(stream).not.toHaveBeenCalled()
  evolution.endTurn(true)
  now += 599_999
  await evolution.tick()
  expect(stream).not.toHaveBeenCalled()
  now++
  await evolution.tick()
  expect(stream).toHaveBeenCalledTimes(1)

  const pressure: Context = { messages: Array.from({ length: 40 }, () => ({ role: 'user', content: 'context' })) }
  const another = createEvolution(model, pressure, cwd, vi.fn())
  await another.beginTurn(); another.endTurn(false)
  now += 600_000
  await another.tick()
  expect(stream).toHaveBeenCalledTimes(1)
  pressure.messages.push({ role: 'user', content: 'over 80%' })
  await another.tick()
  expect(stream).toHaveBeenCalledTimes(2)
  await another.close()
})

it('cancels and restores a background write before accepting new input, retaining the unreviewed text', async () => {
  let now = 1_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  let ready!: () => void
  const waiting = new Promise<void>(resolve => { ready = resolve })
  stream.mockImplementationOnce(write).mockImplementationOnce(async function* (_model, _context, options) {
    ready()
    await new Promise<void>(resolve => { options.signal!.addEventListener('abort', () => resolve(), { once: true }) })
    yield { type: 'done', stopReason: 'aborted' }
  })
  const context: Context = { messages: [...messages] }
  const notify = vi.fn()
  const evolution = createEvolution(model, context, cwd, notify)
  for (let i = 0; i < 6; i++) { await evolution.beginTurn(); evolution.endTurn(true) }
  now += 600_000
  const background = evolution.tick()
  await waiting
  expect(await fs.readFile(file, 'utf8')).toBe('完成')
  await evolution.beginTurn()
  await background
  await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(notify).not.toHaveBeenCalled()
  context.messages.push({ role: 'user', content: '新的输入' })
  evolution.endTurn(true)
  now += 600_000
  await evolution.tick()
  const transcript = stream.mock.calls[2][1].messages[0].content
  expect(transcript).toContain('请补写报告')
  expect(transcript).toContain('新的输入')
})

it('lets new input proceed after a background model failure has been fully restored', async () => {
  await fs.writeFile(file, 'original')
  let restoring!: () => void
  let release!: () => void
  const started = new Promise<void>(resolve => { restoring = resolve })
  const resume = new Promise<void>(resolve => { release = resolve })
  const rename = fs.rename.bind(fs)
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to) === file) { restoring(); await resume }
    return rename(from, to)
  })
  stream.mockImplementationOnce(write).mockImplementationOnce(async function* () {
    yield { type: 'error', error: new Error('network failure') }
  })
  const evolution = createEvolution(model, { messages: [...messages] }, cwd, vi.fn())
  const failed = expect(evolution.run()).rejects.toThrow('未正常结束')
  await started
  const foreground = evolution.beginTurn()
  release()
  await foreground
  await failed
  expect(await fs.readFile(file, 'utf8')).toBe('original')
  evolution.endTurn(true)
})
