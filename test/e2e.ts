// test/e2e.ts — 端到端真实测试
// 用 deepseek-flash（可通过 MINIPI_MODEL 覆盖）验证 minipi 的 stream + runAgent + tools 跨模块集成。
// 用法: npx tsx test/e2e.ts

import { promises as fs } from 'node:fs'
import { runAgent } from '../src/agent.js'
import { builtinTools } from '../src/tools.js'
import type { Model, Context } from '../src/llm.js'

const MODEL = process.env.MINIPI_MODEL ?? 'deepseek-flash'
const BASE_URL = process.env.MINIPI_BASE_URL ?? 'https://api.openai.com/v1'

async function main() {
  const API_KEY = process.env.MINIPI_API_KEY
  if (!API_KEY) { console.error('请设置 MINIPI_API_KEY 环境变量'); process.exit(1) }

  const model: Model = { apiKey: API_KEY, model: MODEL, baseUrl: BASE_URL, maxTokens: 4096 }
  const tools = builtinTools()
  const context: Context = {
    systemPrompt: '你是一个编码助手。用提供的工具读写文件和执行命令来完成任务。',
    messages: [{ role: 'user', content: '请在 /tmp/minipi-e2e-test.txt 写入 "Hello from minipi!"，然后用 read_file 读取它确认内容。' }],
  }

  console.log(`=== minipi E2E 测试 (${MODEL}) ===\n`)

  let eventCount = 0
  for await (const ev of runAgent(model, context, tools)) {
    eventCount++
    switch (ev.type) {
      case 'assistant_text': process.stdout.write(ev.delta); break
      case 'tool_call': console.log(`\n  [tool_call] ${ev.name} ${JSON.stringify(ev.args)}`); break
      case 'tool_result': console.log(`  [tool_result] ${ev.result.slice(0, 200)}`); break
      case 'turn_end': console.log(`\n  [turn_end] stopReason=${ev.stopReason}`); break
    }
  }

  console.log(`\n=== 完成：${eventCount} 个事件，${context.messages.length} 条消息 ===`)

  try {
    const content = await fs.readFile('/tmp/minipi-e2e-test.txt', 'utf-8')
    console.log(content === 'Hello from minipi!' ? '✅ 文件内容正确' : `❌ 文件内容不符: "${content}"`)
    await fs.unlink('/tmp/minipi-e2e-test.txt')
  } catch {
    console.log('❌ 文件未创建')
  }
}

main().catch(console.error)
