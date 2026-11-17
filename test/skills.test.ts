import { afterEach, beforeEach, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

let dir: string
beforeEach(async () => { dir = await fs.mkdtemp(path.join(tmpdir(), 'minipi-skills-')) })
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

const reply = { role: 'assistant', content: 'ok' }
const user = (content: string) => ({ role: 'user', content })

async function chat(steps: Array<() => string | Promise<string>>, ...args: string[]) {
  const trace = path.join(dir, 'requests.jsonl')
  const probe = `
    import { appendFileSync } from 'node:fs'
    globalThis.fetch = (_url, init) => {
      const messages = JSON.parse(init.body).messages
      appendFileSync(${JSON.stringify(trace)}, JSON.stringify(messages) + '\\n')
      const save = messages.at(-1).role === 'user' && messages.at(-1).content === '以后周报先写风险'
      const delta = save ? { content: '保存偏好', tool_calls: [{
        index: 0, id: 'save', function: { name: 'edit', arguments: JSON.stringify({
          path: ${JSON.stringify(path.join(dir, '.minipi', 'MEMORY.md'))}, old_string: '', new_string: '周报先写风险',
        }) },
      }] } : { content: 'ok' }
      const chunk = { choices: [{ delta, finish_reason: save ? 'tool_calls' : 'stop' }] }
      return new Response('data: ' + JSON.stringify(chunk) + '\\n\\n')
    }`
  const child = spawn(process.execPath, [
    '--import', createRequire(import.meta.url).resolve('tsx'),
    '--import', `data:text/javascript,${encodeURIComponent(probe)}`,
    fileURLToPath(new URL('../src/cli.ts', import.meta.url)), ...args,
  ], { cwd: dir, env: { ...process.env, HOME: dir, MINIPI_API_KEY: 'test' }, timeout: 5000 })
  const closed = once(child, 'close')
  let output = ''
  try {
    for await (const chunk of child.stdout.setEncoding('utf8')) {
      output += chunk
      if (!output.endsWith('> ')) continue
      output = ''
      const step = steps.shift()
      if (step) child.stdin.write(await step() + '\n')
      else child.stdin.end()
    }
    expect((await closed)[0]).toBe(0)
    expect(steps).toHaveLength(0)
  } finally {
    child.kill()
  }
}

async function readRequests() {
  return (await fs.readFile(path.join(dir, 'requests.jsonl'), 'utf8')).trimEnd().split('\n').map(line => {
    const messages: unknown = JSON.parse(line)
    if (!Array.isArray(messages) || !messages.every((m: unknown): m is { role: string; content: string } =>
      typeof m === 'object' && m !== null && 'role' in m && typeof m.role === 'string' &&
      'content' in m && typeof m.content === 'string')) throw new Error('模型请求缺少文本消息')
    return messages
  })
}

it('discovers at startup, reloads in place and replays the same request prefix on resume', async () => {
  const folder = path.join(dir, '.minipi', 'skills', 'weekly-report')
  const file = path.join(folder, 'SKILL.md')
  const extra = path.join(folder, '..', 'triage')
  await fs.mkdir(folder, { recursive: true })
  await fs.writeFile(file, '---\nname: weekly-report\n---\n缺用途')
  const header = '---\ndescription: >\n  个人周报\n---\n'
  await chat([
    () => '第一条',
    async () => {
      await fs.writeFile(file, header + '正文甲')
      await fs.mkdir(extra)
      await fs.writeFile(path.join(extra, 'SKILL.md'), '---\ndescription: 整理缺陷\n---\n缺陷步骤')
      return '刷新前'
    },
    async () => { await fs.writeFile(path.join(dir, '.minipi', 'MEMORY.md'), '风险优先'); return '/reload' },
    () => '刷新后',
    async () => { await fs.writeFile(file, header + '正文乙'); return '/reload' },
    () => '/reload',
    () => '仅改正文',
  ])
  await chat([() => '续聊', async () => {
    await fs.unlink(file)
    await fs.rm(extra, { recursive: true })
    return '/reload'
  }, () => '删除后', ...Array.from({ length: 24 }, (_, i) => () => `继续 ${i}`)], '-c')
  await chat([() => '压缩后续聊'], '-c')

  const requests = await readRequests()
  const [first, before, after, bodyOnly, resumed, removed] = requests
  const builtin = first[1]
  expect(builtin).toEqual({ role: 'system', content: expect.stringContaining('weekly-report') })
  expect(builtin.content).not.toContain(file)
  expect(builtin.content).not.toContain('triage')
  expect(before).toEqual([...first, reply, user('刷新前')])
  const personal = { role: 'system', content: expect.stringContaining(file) }
  const preference = { role: 'system', content: expect.stringContaining('风险优先') }
  expect(after).toEqual([...before, reply, personal, preference, user('刷新后')])
  expect(after.at(-3)?.content).toContain('个人周报')
  expect(after.at(-3)?.content).toContain('triage')
  expect(after.at(-3)?.content).not.toContain('正文甲')
  expect(bodyOnly).toEqual([...after, reply, user('仅改正文')])
  expect(resumed).toEqual([...bodyOnly, reply, user('续聊')])
  expect(removed).toEqual([...resumed, reply, builtin, user('删除后')])
  const [compacted, continued] = requests.slice(-2)
  expect(compacted.filter(m => m.role === 'system')).toEqual([first[0], preference, builtin])
  expect(compacted).toContainEqual(user('[context summary]\nok'))
  expect(continued).toEqual([...compacted, reply, user('压缩后续聊')])
})

it('appends full preference changes before the next user input and preserves the wire prefix', async () => {
  const memory = path.join(dir, '.minipi', 'MEMORY.md')
  await fs.mkdir(path.dirname(memory))
  await fs.writeFile(memory, '附统计日期\n')
  await chat([
    ...Array.from({ length: 9 }, (_, i) => () => `第${i + 1}轮`),
    () => '以后周报先写风险', () => '第十一轮', () => '第十二轮',
  ])
  expect(await fs.readFile(memory, 'utf8')).toBe('附统计日期\n周报先写风险\n')
  await chat([
    () => '续聊', async () => { await fs.unlink(memory); return '删除偏好' },
    async () => { await fs.writeFile(memory, '新偏好'); return '重新设置' },
    async () => { await fs.writeFile(memory, '  \n'); return '清空偏好' }, () => '仍为空',
  ], '-c')

  const requests = await readRequests()
  expect(requests).toHaveLength(18) // 第十轮额外有一次带 edit 结果的请求。
  const [first] = requests
  const [ten, toolResult, eleven, twelve, resumed, deleted, reset, cleared, empty] = requests.slice(9)
  expect(first[0].content).not.toContain('附统计日期')
  expect(first[2]).toEqual({ role: 'system', content: expect.stringContaining('附统计日期') })
  expect(ten.filter(m => m.role === 'system')).toEqual(first.slice(0, 3))
  expect(toolResult.slice(0, -2)).toEqual(ten)
  expect(toolResult.at(-1)).toMatchObject({ role: 'tool', content: '个人偏好已保存' })
  const prefs = (text: string) => ({ role: 'system', content: expect.stringContaining(text) })
  expect(eleven).toEqual([...toolResult, reply, prefs('附统计日期\n周报先写风险'), user('第十一轮')])
  expect(twelve).toEqual([...eleven, reply, user('第十二轮')])
  expect(resumed).toEqual([...twelve, reply, user('续聊')])
  expect(deleted).toEqual([...resumed, reply, prefs('当前长期偏好为空'), user('删除偏好')])
  expect(reset).toEqual([...deleted, reply, prefs('新偏好'), user('重新设置')])
  expect(cleared).toEqual([...reset, reply, deleted.at(-2), user('清空偏好')])
  expect(empty).toEqual([...cleared, reply, user('仍为空')])
})
