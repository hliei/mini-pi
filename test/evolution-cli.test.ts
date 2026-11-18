import { afterEach, beforeEach, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

let dir: string
beforeEach(async () => { dir = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'minipi-reflection-cli-'))) })
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

async function chat(script: string, input: (output: string) => string | null, ...args: string[]) {
  const child = spawn(process.execPath, [
    '--import', createRequire(import.meta.url).resolve('tsx'),
    '--import', `data:text/javascript,${encodeURIComponent(script)}`,
    fileURLToPath(new URL('../src/cli.ts', import.meta.url)), ...args,
  ], { cwd: dir, env: { ...process.env, HOME: dir, MINIPI_API_KEY: 'test', MINIPI_SELF_EVOLUTION: 'true' }, timeout: 10_000 })
  const closed = once(child, 'close')
  let output = ''
  let errors = ''
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { errors += chunk })
  try {
    for await (const chunk of child.stdout.setEncoding('utf8')) {
      output += chunk
      const next = input(output)
      if (next === null) child.stdin.end()
      else if (next) child.stdin.write(next + '\n')
    }
    expect((await closed)[0], errors || output).toBe(0)
    expect(errors).toBe('')
    return output
  } finally { child.kill() }
}

it('manual review, inspection, fresh-session discovery and natural-language undo use the real CLI', async () => {
  const folder = path.join(dir, '.minipi', 'skills', 'my-weekly-report')
  await fs.mkdir(folder, { recursive: true })
  const skill = path.join(folder, 'SKILL.md')
  const original = '---\nname: my-weekly-report\ndescription: 个人周报\n---\n按提交写周报\n'
  await fs.writeFile(skill, original)
  const created = path.join(folder, '..', 'release-check', 'SKILL.md')
  const trace = path.join(dir, 'requests.jsonl')
  const probe = `import { appendFileSync } from 'node:fs'
    globalThis.fetch = (_url, init) => {
      const { messages } = JSON.parse(init.body)
      appendFileSync(${JSON.stringify(trace)}, JSON.stringify(messages) + '\\n')
      const review = messages[0].content.startsWith('你正在独立复盘')
      let delta = { content: '完成' }
      if (review && messages.at(-1).role === 'user') delta = { tool_calls: [
        { index: 0, id: 'edit-skill', function: { name: 'edit', arguments: JSON.stringify({
          path: ${JSON.stringify(skill)}, old_string: '按提交写周报', new_string: '排除合并提交后写周报'
        }) } },
        { index: 1, id: 'new-skill', function: { name: 'write_file', arguments: JSON.stringify({
          path: ${JSON.stringify(created)}, content: '---\\nname: release-check\\ndescription: 检查发布\\n---\\n核对批准记录。\\n'
        }) } }
      ] }
      else if (review) delta = { content: '已修订周报并新增发布检查技能。' }
      else if (messages.at(-1).content === '撤销复盘') {
        const notice = messages.find(m => typeof m.content === 'string' && m.content.startsWith('[EVOLUTION]'))
        const id = /id=([\\w-]+)/.exec(notice.content)[1]
        delta = { tool_calls: [{ index: 0, id: 'undo', function: {
          name: 'undo_reflection', arguments: JSON.stringify({ id })
        } }] }
      }
      return Promise.resolve(new Response('data: ' + JSON.stringify({ choices: [{
        delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop'
      }] }) + '\\n\\n'))
    }`
  let id = ''
  let step = 0
  let lastPromptLength = 0
  const output = await chat(probe, output => {
    if (!output.endsWith('> ') || output.length === lastPromptLength) return ''
    lastPromptLength = output.length
    switch (step++) {
      case 0: return '合并提交不能重复计数，请在以后的周报中排除'
      case 1: return '/reflect'
      case 2:
        id = /id=([\w-]+)/.exec(output)![1]
        return '/reflect show ' + id
      case 3: return '/reflect list'
      case 4: return '使用新技能'
      default: return null
    }
  })
  expect(output).toContain('+排除合并提交后写周报')
  expect(output).toContain('[complete]')
  expect(await fs.readFile(skill, 'utf8')).toContain('排除合并提交')
  expect(await fs.readFile(trace, 'utf8')).toContain(created)

  step = 0; lastPromptLength = 0
  await chat(probe, output => {
    if (!output.endsWith('> ') || output.length === lastPromptLength) return ''
    lastPromptLength = output.length
    return step++ === 0 ? '新会话使用新技能' : null
  })
  const fresh = (await fs.readFile(trace, 'utf8')).trim().split('\n').at(-1)!
  expect(fresh).toContain(created)
  expect(fresh).not.toContain('合并提交不能重复计数，请在以后的周报中排除')

  // 恢复原会话，使确定性撤销工具可以取到已保存的备份 ID。
  const sessions = path.join(dir, '.minipi', 'sessions')
  const [key] = await fs.readdir(sessions)
  for (const file of await fs.readdir(path.join(sessions, key))) {
    const target = path.join(sessions, key, file)
    if ((await fs.readFile(target, 'utf8')).includes(id)) await fs.utimes(target, new Date('2100-01-01'), new Date('2100-01-01'))
  }
  step = 0; lastPromptLength = 0
  await chat(probe, output => {
    if (!output.endsWith('> ') || output.length === lastPromptLength) return ''
    lastPromptLength = output.length
    return ['撤销复盘', '撤销后检查清单'][step++] ?? null
  }, '-c')
  expect(await fs.readFile(skill, 'utf8')).toBe(original)
  await expect(fs.stat(created)).rejects.toMatchObject({ code: 'ENOENT' })
  const finalRequest = (await fs.readFile(trace, 'utf8')).trim().split('\n').at(-1)!
  const wire: unknown = JSON.parse(finalRequest)
  expect(wire).toEqual(expect.arrayContaining([{ role: 'tool', tool_call_id: 'undo', content: expect.stringContaining('已撤销复盘') }]))
  // 最后一份技能清单已移除新技能；历史中仍保留旧清单供续聊。
  expect(finalRequest.lastIndexOf('当前可用技能')).toBeGreaterThan(finalRequest.lastIndexOf(created))
})

it('starts automatically without a command, then restores before processing an arriving user message', async () => {
  const report = path.join(dir, 'report.md')
  const probe = `import { existsSync } from 'node:fs'
    let clock = 1000000
    Date.now = () => clock
    const interval = globalThis.setInterval
    globalThis.setInterval = (callback, _delay) => interval(() => { clock += 60000; callback() }, 5)
    globalThis.fetch = (_url, init) => {
      const { messages } = JSON.parse(init.body)
      const review = messages[0].content.startsWith('你正在独立复盘')
      if (review && messages.at(-1).role === 'tool') {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true })
          console.log('REFLECTION_WAITING')
        })
      }
      let delta = { content: '普通回复' }
      if (review) delta = { tool_calls: [{ index: 0, id: 'write', function: {
        name: 'write_file', arguments: JSON.stringify({ path: 'report.md', content: 'background' })
      } }] }
      else if (messages.at(-1).content === '新的输入') {
        if (existsSync(${JSON.stringify(report)})) throw new Error('foreground ran before rollback')
        delta = { content: 'NEW_INPUT_PROCESSED' }
      }
      return Promise.resolve(new Response('data: ' + JSON.stringify({ choices: [{
        delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop'
      }] }) + '\\n\\n'))
    }`
  let turns = 0
  let interrupted = false
  let lastPromptLength = 0
  const output = await chat(probe, output => {
    if (output.includes('REFLECTION_WAITING') && !interrupted) { interrupted = true; return '新的输入' }
    if (!output.endsWith('> ') || output.length === lastPromptLength) return ''
    lastPromptLength = output.length
    if (output.includes('NEW_INPUT_PROCESSED')) return null
    return turns++ < 6 ? '请完成报告 ' + turns : ''
  })
  expect(output).toContain('REFLECTION_WAITING')
  expect(output).toContain('NEW_INPUT_PROCESSED')
  expect(output).not.toContain('[EVOLUTION]')
  await expect(fs.stat(report)).rejects.toMatchObject({ code: 'ENOENT' })
})
