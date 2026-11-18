// test/cli.test.ts
// 测试 session 持久化的核心 round-trip。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { openSession } from '../src/session.js'
import type { Message } from '../src/llm.js'

let tmpFile: string

beforeEach(() => { tmpFile = path.join(os.tmpdir(), `minipi-session-${Date.now()}.jsonl`) })
afterEach(async () => { await fs.rm(tmpFile, { force: true }) })

it('starts the CLI through a command symlink', async () => {
  await fs.symlink(new URL('../src/cli.ts', import.meta.url), tmpFile)
  const result = spawnSync(process.execPath, ['--import', 'tsx', tmpFile], {
    encoding: 'utf8',
    env: { ...process.env, MINIPI_API_KEY: '' },
    timeout: 5000,
  })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('请在 .env 中设置 MINIPI_API_KEY')
})

describe('.env startup configuration', () => {
  let dir: string
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minipi-env-')) })
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

  it.each([
    { name: 'loads .env', file: true, exported: false, status: 0 },
    { name: 'keeps exported values', file: true, exported: true, status: 0 },
    { name: 'allows exports without .env', file: false, exported: true, status: 0 },
    { name: 'rejects a missing key', file: false, exported: false, status: 1 },
  ])('$name', async ({ file, exported, status }) => {
    const values = {
      MINIPI_API_KEY: 'test-key',
      MINIPI_MODEL: 'test-model',
      MINIPI_BASE_URL: 'https://example.invalid/v1',
    }
    if (file) {
      await fs.writeFile(path.join(dir, '.env'), Object.entries(values)
        .map(([key, value]) => `${key}="${value}"`).join('\n'))
    }
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir }
    for (const key of Object.keys(values)) delete env[key]
    if (exported) Object.assign(env, values, { MINIPI_MODEL: 'exported-model' })

    // Read the child environment after CLI startup without calling a real model.
    const probe = `process.on('exit', () => console.log('CONFIG:' + JSON.stringify(
      Object.fromEntries(${JSON.stringify(Object.keys(values))}.map(key => [key, process.env[key]]))
    )))`
    const result = spawnSync(process.execPath, [
      '--import', createRequire(import.meta.url).resolve('tsx'),
      '--import', `data:text/javascript,${encodeURIComponent(probe)}`,
      fileURLToPath(new URL('../src/cli.ts', import.meta.url)),
    ], { cwd: dir, env, encoding: 'utf8', input: '', timeout: 5000 })

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(status)
    const config = JSON.parse(result.stdout.split('CONFIG:')[1])
    expect(config).toEqual(exported ? { ...values, MINIPI_MODEL: 'exported-model' } : file ? values : {})
    if (status === 0) expect(result.stdout).toContain('> ')
    else expect(result.stderr).toContain('请在 .env 中设置 MINIPI_API_KEY')
  })
})

describe('session persistence', () => {
  let dir: string
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minipi-chats-')) })
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

  it('starts fresh by default and continues only the last chat in the same directory', async () => {
    const projectB = path.join(dir, 'b')
    await fs.mkdir(projectB)
    // 在请求模型时退出：实际 CLI 必须已经保存本次输入，且空启动不能抢占最近会话。
    const probe = `globalThis.fetch = (_url, init) => {
      const messages = JSON.parse(init.body).messages
      console.log('REQUEST:' + JSON.stringify({ systems: messages.filter(m => m.role === 'system').map(m => m.content),
        prompts: messages.filter(m => m.role === 'user').map(m => m.content) }))
      process.exit(0)
    }`
    function run(cwd: string, input: string, ...args: string[]) {
      const result = spawnSync(process.execPath, [
        '--import', createRequire(import.meta.url).resolve('tsx'),
        '--import', `data:text/javascript,${encodeURIComponent(probe)}`,
        fileURLToPath(new URL('../src/cli.ts', import.meta.url)), ...args,
      ], { cwd, env: { ...process.env, HOME: dir, MINIPI_API_KEY: 'test-key' }, input, encoding: 'utf8', timeout: 5000 })
      expect(result.status, result.stderr).toBe(0)
      return input ? JSON.parse(result.stdout.split('REQUEST:')[1]) : undefined
    }
    expect(run(dir, 'A1\n').prompts).toEqual(['A1'])
    run(dir, '')
    expect(run(dir, 'A2\n', '-c').prompts).toEqual(['A1', 'A2'])
    await fs.writeFile(path.join(dir, '.minipi', 'MEMORY.md'), '周报先放风险表\n')
    const fresh = run(projectB, 'B1\n', '-c')
    expect(fresh.prompts).toEqual(['B1'])
    expect(fresh.systems[0]).not.toContain('周报先放风险表')
    expect(fresh.systems).toContainEqual(expect.stringContaining('周报先放风险表'))
    expect(run(dir, 'A3\n').prompts).toEqual(['A3'])
    expect(run(dir, 'A4\n', '--continue').prompts).toEqual(['A3', 'A4'])
  })

  it.each([false, true])('执行中退出仍能续聊，保存曾失败：%s', async (failSave) => {
    await fs.writeFile(path.join(dir, 'commits.txt'), 'c42：修复超时；性能回归待完成')
    // 在第三次请求直接退出，不给整次 Agent 调用收尾保存的机会。
    const probe = `import { promises as fs } from 'node:fs'
      const append = fs.appendFile.bind(fs)
      let writes = 0
      fs.appendFile = async (...args) => {
        if (++writes === 2 && ${failSave}) throw new Error('injected save failure')
        return append(...args)
      }
      let requests = 0
      globalThis.fetch = () => {
        if (++requests === 3) process.exit(17)
        const file = requests === 1 ? 'commits.txt' : 'milestones.txt'
        return Promise.resolve(new Response('data: ' + JSON.stringify({ choices: [{
          delta: { tool_calls: [{ index: 0, id: 't' + requests,
            function: { name: 'read_file', arguments: JSON.stringify({ path: file }) } }] },
          finish_reason: 'tool_calls'
        }] }) + '\\n\\ndata: [DONE]\\n\\n'))
      }`
    function run(input: string, script: string, ...args: string[]) {
      return spawnSync(process.execPath, [
        '--import', createRequire(import.meta.url).resolve('tsx'),
        '--import', `data:text/javascript,${encodeURIComponent(script)}`,
        fileURLToPath(new URL('../src/cli.ts', import.meta.url)), ...args,
      ], { cwd: dir, env: { ...process.env, HOME: dir, MINIPI_API_KEY: 'test-key' }, input, encoding: 'utf8', timeout: 5000 })
    }
    const interrupted = run('核对提交和里程碑\n', probe)
    expect(interrupted.status, interrupted.stderr).toBe(17)
    if (failSave) expect(interrupted.stderr).toContain('会话进度保存失败')
    else expect(interrupted.stderr).toBe('')

    const cwdKey = createHash('sha256').update(await fs.realpath(dir)).digest('hex')
    const saved = await openSession(path.join(dir, '.minipi', 'sessions', cwdKey), true)
    expect(saved.messages.filter(message => Array.isArray(message.content))).toEqual([
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'commits.txt' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'c42：修复超时；性能回归待完成' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'read_file', input: { path: 'milestones.txt' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: expect.stringContaining('ENOENT') }] },
    ])
    const resumed = run('继续\n', `globalThis.fetch = (_url, init) => {
      console.log('REQUEST:' + init.body)
      process.exit(0)
    }`, '--continue')
    expect(resumed.status, resumed.stderr).toBe(0)
    const request: unknown = JSON.parse(resumed.stdout.split('REQUEST:')[1])
    expect(request).toMatchObject({ messages: expect.arrayContaining([
      { role: 'tool', tool_call_id: 't1', content: 'c42：修复超时；性能回归待完成' },
      { role: 'tool', tool_call_id: 't2', content: expect.stringContaining('ENOENT') },
      { role: 'user', content: '继续' },
    ]) })
  })

  it('selects by last activity, skips invalid records and resumes after a torn line', async () => {
    const first = await openSession(dir, false)
    expect(await fs.readdir(dir)).toEqual([])
    expect(path.basename(first.file)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[a-f0-9-]{36}\.jsonl$/)
    first.messages.push({ role: 'user', content: 'one' })
    await first.save(first.messages)
    const second = await openSession(dir, false)
    second.messages.push({ role: 'user', content: 'two' })
    await second.save(second.messages)
    await fs.utimes(second.file, 1, 1)
    await fs.appendFile(first.file, '{"role":"system","content":"invalid"}\n{"role":"user","content":[null]}\n{"role":')
    const broken = path.join(dir, 'broken.jsonl')
    await fs.writeFile(broken, '{"role":"system","section":"skills","content":"catalog"}\n{"role":"user",')
    await fs.utimes(broken, new Date('2100-01-01'), new Date('2100-01-01'))

    const resumed = await openSession(dir, true)
    expect(resumed.file).toBe(first.file)
    expect(resumed.messages).toEqual(first.messages)
    resumed.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'reply' }] })
    await resumed.save(resumed.messages)
    expect((await openSession(dir, true)).messages).toEqual(resumed.messages)
  })

  it('rewrites the file after context compaction before appending new messages', async () => {
    const session = await openSession(dir, false)
    session.messages.push(
      { role: 'user', content: 'old-1' },
      { role: 'assistant', content: 'old-2' },
      { role: 'user', content: 'old-3' },
    )
    const compacted: Message[] = [
      { role: 'system', section: 'knowledge', content: '当前知识索引' },
      { role: 'user', content: '[context summary]' },
      { role: 'assistant', content: 'recent' },
    ]
    await session.save(session.messages)
    const resumed = await openSession(dir, true)
    await resumed.save(compacted)
    compacted.push({ role: 'user', content: 'new prompt' })
    await resumed.save(compacted)
    expect((await openSession(dir, true)).messages).toEqual(compacted)
  })
})
