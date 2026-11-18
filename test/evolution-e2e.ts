// 真实模型：纠正 → 手动复盘 → 新会话新材料 → 撤销。所有资料和会话位于临时 HOME。
// node --env-file=.env --import tsx test/evolution-e2e.ts
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openSession } from '../src/session.js'
import type { Message } from '../src/llm.js'

async function main() {
  assert(process.env.MINIPI_API_KEY, '请提供 MINIPI_API_KEY')
  const dir = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'minipi-evolution-e2e-')))
  const key = createHash('sha256').update(dir).digest('hex')
  const sessionDir = path.join(dir, '.minipi', 'sessions', key)
  const skill = path.join(dir, '.minipi', 'skills', 'my-weekly-report', 'SKILL.md')
  const original = '---\nname: my-weekly-report\ndescription: 按指定提交清单生成个人周报，统计完成项数量并列出进展\n---\n1. 用 read_file 读取用户指定的 JSON 提交清单。\n2. 以清单中的提交记录条数作为完成项数量。\n3. 写明完成项数量，列出具体进展。\n'
  async function chat(prompts: string[], ...args: string[]) {
    const child = spawn(process.execPath, [
      '--import', createRequire(import.meta.url).resolve('tsx'),
      fileURLToPath(new URL('../src/cli.ts', import.meta.url)), ...args,
    ], { cwd: dir, env: { ...process.env, HOME: dir, MINIPI_SELF_EVOLUTION: 'false' }, timeout: 240_000 })
    const closed = once(child, 'close')
    let pending = ''
    let output = ''
    let errors = ''
    let index = 0
    child.stderr.setEncoding('utf8').on('data', (text: string) => { errors += text })
    try {
      for await (const chunk of child.stdout.setEncoding('utf8')) {
        process.stdout.write(chunk)
        output += chunk
        pending += chunk
        if (!pending.endsWith('> ')) continue
        pending = ''
        if (index < prompts.length) { console.log('\n输入：' + prompts[index]); child.stdin.write(prompts[index++] + '\n') }
        else child.stdin.end()
      }
      assert.equal((await closed)[0], 0, errors || 'CLI 超时或异常退出')
      assert.equal(errors, '')
      assert.equal(index, prompts.length)
    } finally { child.kill() }
    return { output, messages: (await openSession(sessionDir, true)).messages }
  }
  function answer(messages: Message[]) {
    const last = messages.at(-1)
    assert(last?.role === 'assistant')
    return typeof last.content === 'string' ? last.content : last.content.filter(block => block.type === 'text').map(block => block.text).join('')
  }
  try {
    await fs.mkdir(path.dirname(skill), { recursive: true })
    await fs.writeFile(skill, original)
    await fs.writeFile(path.join(dir, 'week1.json'), JSON.stringify([
      { hash: 'a1', parents: ['a0'], message: '完成导出修复' },
      { hash: 'a2', parents: ['a1'], message: '完成搜索优化' },
      { hash: 'a3', parents: ['a0', 'a2'], message: 'Merge branch export-and-search' },
    ]))
    const reviewed = await chat([
      `请用 my-weekly-report，根据 ${path.join(dir, 'week1.json')} 写本周周报，明确完成项数量并列出各项。`,
      '这里三条记录只有两项进展：a3 是 merge 提交，只合并已有工作，不是独立完成项。这是技能统计步骤的问题。本轮请先更正这份周报的数量。',
      '/reflect',
    ])
    const id = /\[EVOLUTION\] id=([\w-]+)/.exec(reviewed.output)?.[1]
    assert(id, '复盘没有产生实际修改及备份 ID')
    const revised = await fs.readFile(skill, 'utf8')
    assert.notEqual(revised, original, '个人技能没有修订')
    assert(/merge|合并/i.test(revised), '技能缺少合并提交的处理规则')
    // 复盘完成后才提供新一周资料，避免验收数据提前进入学习过程。
    await fs.writeFile(path.join(dir, 'week2.json'), JSON.stringify([
      { hash: 'b1', parents: ['b0'], message: '完成登录修复' },
      { hash: 'b2', parents: ['b1'], message: '完成账单导出' },
      { hash: 'b3', parents: ['b0', 'b2'], message: 'Merge branch billing' },
      { hash: 'b4', parents: ['b3'], message: '完成邮件通知' },
      { hash: 'b5', parents: ['b0', 'b4'], message: 'Merge branch notifications' },
    ]))
    const fresh = await chat([`请用 my-weekly-report，根据 ${path.join(dir, 'week2.json')} 写本周周报，明确完成项数量并列出各项。`])
    assert(!fresh.messages.some(message => typeof message.content === 'string' && message.content.includes('a3 是 merge')), '新会话带入了旧纠正')
    const calls = fresh.messages.flatMap(message => typeof message.content === 'string' ? [] : message.content.filter(block => block.type === 'tool_use'))
    assert(calls.some(call => call.name === 'read_file' && JSON.stringify(call.input).includes(skill)), '新会话没有读取个人技能')
    assert(/3\s*项|三项/.test(answer(fresh.messages)), '新材料没有统计为三项完成进展')
    await chat(['/reflect undo ' + id])
    assert.equal(await fs.readFile(skill, 'utf8'), original, '撤销没有恢复旧技能')
    console.log('\n阶段五真实模型验收通过：复盘修订技能、新会话新材料复用、撤销恢复旧版。')
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
