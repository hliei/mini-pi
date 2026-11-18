// 真实模型验证缺材料后的进展说明与续聊；资料及会话全部位于临时目录。
// node --env-file=.env --import tsx test/multi-step-e2e.ts
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

function answer(messages: Message[]): string {
  const last = messages.at(-1)
  assert(last?.role === 'assistant')
  return typeof last.content === 'string' ? last.content : last.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

async function main() {
  assert(process.env.MINIPI_API_KEY, '请提供 MINIPI_API_KEY')
  const dir = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'minipi-progress-e2e-')))
  const cwdKey = createHash('sha256').update(dir).digest('hex')
  const sessionDir = path.join(dir, '.minipi', 'sessions', cwdKey)
  async function chat(prompt: string, ...args: string[]) {
    console.log('\n请求：' + prompt)
    const child = spawn(process.execPath, [
      '--import', createRequire(import.meta.url).resolve('tsx'),
      fileURLToPath(new URL('../src/cli.ts', import.meta.url)), ...args,
    ], { cwd: dir, env: { ...process.env, HOME: dir }, timeout: 180_000 })
    const closed = once(child, 'close')
    let sent = false
    let pending = ''
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (text: string) => { stderr += text })
    try {
      for await (const chunk of child.stdout.setEncoding('utf8')) {
        process.stdout.write(chunk)
        pending += chunk
        if (!pending.endsWith('> ')) continue
        pending = ''
        if (!sent) { sent = true; child.stdin.write(prompt + '\n') }
        else child.stdin.end()
      }
      assert.equal((await closed)[0], 0, stderr || 'CLI 超时或异常退出')
      assert.equal(stderr, '')
    } finally { child.kill() }
    return (await openSession(sessionDir, true)).messages
  }

  try {
    await fs.writeFile(path.join(dir, 'commits.txt'), 'c42：修复请求超时，已合入。c43：性能回归测试尚未完成。\n')
    await fs.writeFile(path.join(dir, 'risks.txt'), 'R7：第三方接口配额不足，可能影响发布。\n')
    const first = await chat('请核对 commits.txt、milestones.txt 和 risks.txt，汇总项目进展、里程碑和风险。本次材料只有这三份文本文件，不需要查询 Git。')
    const firstAnswer = answer(first)
    assert(/milestones\.txt/.test(firstAnswer) && /缺|不存在|未找到|无法|未提供|未能/.test(firstAnswer), '没有说明里程碑材料缺失')
    assert(/超时/.test(firstAnswer) && /配额/.test(firstAnswer), '没有保留已完成的核对结果')
    assert(/补|提供/.test(firstAnswer), '没有说明继续条件')
    const firstResults = first.flatMap(message => typeof message.content === 'string' ? [] : message.content.filter(block => block.type === 'tool_result'))
    const checks = first.flatMap(message => typeof message.content === 'string' ? [] : message.content.filter(block => block.type === 'tool_use'))
    assert(checks.some(check => JSON.stringify(check.input).includes('milestones') && firstResults.some(result => result.tool_use_id === check.id)), '没有实际检查里程碑材料')
    assert(first.slice(0, -1).some(message => message.role === 'assistant' && Array.isArray(message.content) && message.content.some(block => block.type === 'text' && block.text.trim())), '执行过程中没有进度说明')

    await fs.writeFile(path.join(dir, 'milestones.txt'), 'M8：11 月 20 日完成预发布验收；正式发布尚未批准。\n')
    const resumed = await chat('已补上 milestones.txt，请继续完成汇总。', '--continue')
    assert.deepEqual(resumed.slice(0, first.length), first, '续聊丢失了已保存记录')
    const finalAnswer = answer(resumed)
    assert(/预发布/.test(finalAnswer) && /20/.test(finalAnswer), '没有采用新材料')
    assert(/超时/.test(finalAnswer) && /配额/.test(finalAnswer), '最终汇总丢失此前的核对结果')
    assert(/未批准|尚未|待批准/.test(finalAnswer), '把尚未批准的正式发布当成完成')
    const simple = await chat('3 加 4 等于几？')
    assert(!simple.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'tool_use')), '简单问题增加了工具流程')
    assert(/7|七/.test(answer(simple)))
    console.log('\n阶段四真实模型验收通过：缺口报告、已完成结果保留、补材料续聊、简单问题直接回答。')
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
