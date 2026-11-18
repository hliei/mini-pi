// 使用真实模型验证资料整理、跨目录新会话周报和无关请求；所有资料与会话均在临时目录。
// node --env-file=.env --import tsx test/knowledge-e2e.ts
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openSession } from '../src/session.js'
import type { Message } from '../src/llm.js'

function reads(messages: Message[]): string[] {
  const paths: string[] = []
  for (const message of messages) {
    if (message.role !== 'assistant' || typeof message.content === 'string') continue
    for (const block of message.content) {
      if (block.type !== 'tool_use' || block.name !== 'read_file') continue
      const input = block.input
      if (input && typeof input === 'object' && 'path' in input && typeof input.path === 'string') paths.push(input.path)
    }
  }
  return paths
}

async function main() {
  assert(process.env.MINIPI_API_KEY, '请提供 MINIPI_API_KEY')
  const dir = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'minipi-knowledge-e2e-')))
  const source = path.join(dir, '发布说明.md')
  const material = '# 青禾项目发布流程\n\n灰度完成仅指对 20 个内部账户开放并观察 24 小时。\n全量发布必须另有发布负责人的确认记录。\n'
  const knowledge = path.join(dir, '.minipi', 'knowledge')
  async function chat(cwd: string, prompt: string) {
    console.log(`\n请求：${prompt}`)
    const child = spawn(process.execPath, [
      '--import', createRequire(import.meta.url).resolve('tsx'),
      fileURLToPath(new URL('../src/cli.ts', import.meta.url)),
    ], { cwd, env: { ...process.env, HOME: dir }, timeout: 180_000 })
    const closed = once(child, 'close')
    let sent = false
    let pending = ''
    let stderr = ''
    child.stderr.setEncoding('utf8').on('data', (text: string) => { stderr += text })
    try {
      for await (const chunk of child.stdout.setEncoding('utf8')) {
        pending += chunk
        if (!pending.endsWith('> ')) continue
        pending = ''
        if (!sent) { sent = true; child.stdin.write(prompt + '\n') }
        else child.stdin.end()
      }
      assert.equal((await closed)[0], 0, stderr || 'CLI 超时或异常退出')
      assert.equal(stderr, '')
    } finally { child.kill() }
    const cwdKey = createHash('sha256').update(cwd).digest('hex')
    const messages = (await openSession(path.join(dir, '.minipi', 'sessions', cwdKey), true)).messages
    console.log('读取轨迹：' + reads(messages).join(' → '))
    return messages
  }

  try {
    await fs.writeFile(source, material)
    const first = await chat(dir, `这是青禾项目的发布流程资料，请阅读 ${source}。`)
    assert(reads(first).some(file => file.endsWith('knowledge-wiki/SKILL.md')), '没有按需读取知识技能')
    assert(reads(first).includes(source), '没有读取原资料')
    assert.equal(await fs.readFile(source, 'utf8'), material, '原资料被改动')
    const pages = (await fs.readdir(knowledge, { recursive: true })).filter(file => file.endsWith('.md') && !['index.md', 'log.md'].includes(file))
    assert(pages.length > 0, '没有生成知识页')
    const saved = await Promise.all(pages.map(file => fs.readFile(path.join(knowledge, file), 'utf8')))
    assert(saved.some(text => text.includes(source) && text.includes('quote:') && text.includes('20')), '知识页缺少来源或证据')
    assert((await fs.readFile(path.join(knowledge, 'index.md'), 'utf8')).includes('青禾'), '索引缺少项目')
    assert((await fs.readFile(path.join(knowledge, 'log.md'), 'utf8')).includes('<!--'), '没有成功的变更记录')

    const project = path.join(dir, 'another-checkout')
    await fs.mkdir(project)
    execFileSync('git', ['init', '-q', project])
    execFileSync('git', ['-C', project, '-c', 'user.name=Knowledge Test', '-c', 'user.email=test@example.invalid', 'commit', '-q', '--allow-empty', '-m', '灰度完成，性能回归待完成'])
    const report = await chat(project, '写青禾项目本周周报。')
    assert.equal(report.filter(message => message.role === 'user' && typeof message.content === 'string').length, 1, '新会话混入旧聊天')
    assert(reads(report).some(file => pages.some(page => file === path.join(knowledge, page))), '没有读取知识正文')
    const last = report.at(-1)
    assert(last?.role === 'assistant')
    const answer = typeof last.content === 'string' ? last.content : last.content.filter(block => block.type === 'text').map(block => block.text).join('')
    assert(/\[[^\]]+\]\([^\n]+\.md[^\n]*\)/.test(answer), '回答没有引用知识页')
    assert(/20/.test(answer) && /24/.test(answer), '周报没有采用资料中特有的灰度含义')
    assert(/(不等于|不代表|不能|未|尚|不应|不意味着|无法)[^。\n]{0,40}全量|全量[^。\n]{0,40}(未|待|需|缺|尚)/.test(answer), '没有说明全量发布仍缺证据')
    console.log('\n模型周报：\n' + answer)
    const unrelated = await chat(project, '3 加 4 等于几？')
    assert(!reads(unrelated).some(file => file.startsWith(knowledge)), '无关问题读取了知识页')
    console.log('\n知识库真实模型验收通过：主动整理、原资料保留、跨目录空白会话引用、无关请求不读页。')
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
