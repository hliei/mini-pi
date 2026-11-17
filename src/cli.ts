#!/usr/bin/env node
// src/cli.ts
// 拼装层 —— 把 llm / agent / tui / tools 粘起来，是唯一入口。

import { realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import * as path from 'node:path'
import * as os from 'node:os'
import { pathToFileURL } from 'node:url'
import { loadEnvFile } from 'node:process'
import { parseArgs } from 'node:util'
import { runAgent } from './agent.js'
import { Tui } from './tui.js'
import { builtinTools } from './tools.js'
import { openSession } from './session.js'
import { preferencePrompt } from './memory.js'
import type { Model, Context } from './llm.js'

/** 固定 system prompt */
const SYSTEM_PROMPT = '你是一个编码助手。用提供的工具读写文件和执行命令来完成任务。先阅读再修改，修改后可运行命令验证。'

async function main() {
  const { values } = parseArgs({ options: { continue: { type: 'boolean', short: 'c' } } })
  try {
    loadEnvFile()
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }

  const apiKey = process.env.MINIPI_API_KEY
  if (!apiKey) {
    console.error('请在 .env 中设置 MINIPI_API_KEY，或设置同名环境变量')
    process.exit(1)
  }

  const model: Model = {
    apiKey,
    model: process.env.MINIPI_MODEL ?? 'deepseek-flash',
    baseUrl: process.env.MINIPI_BASE_URL ?? 'https://api.openai.com/v1',
    maxTokens: 4096,
  }

  // 用路径摘要区分工作目录，避免长路径或目录名中的特殊字符影响存储。
  const cwdKey = createHash('sha256').update(process.cwd()).digest('hex')
  const dir = path.join(os.homedir(), '.minipi', 'sessions', cwdKey)
  const session = await openSession(dir, values.continue === true)
  const context: Context = {
    messages: session.messages,
  }

  const tools = builtinTools()
  const tui = new Tui()

  // 每轮：用户输入 → runAgent → 事件转发到 TUI → 持久化
  tui.onPrompt(async (text) => {
    try {
      tui.setBusy(true)
      const ctrl = new AbortController()
      tui.onAbort(() => ctrl.abort())  // 每轮新建 AbortController，需重新注册回调指向新的 controller
      // 先保存用户输入，即使首轮模型没有回复也能续聊。
      context.messages.push({ role: 'user', content: text })
      try {
        await session.save(context.messages)
      } catch (e) {
        context.messages.pop()
        throw e
      }
      // 每轮请求前取最新偏好，使本会话和其他会话的修改都能生效。
      context.systemPrompt = SYSTEM_PROMPT + '\n\n' + await preferencePrompt()
      for await (const ev of runAgent(model, context, tools, ctrl.signal)) {
        switch (ev.type) {
          case 'assistant_text': tui.printText(ev.delta); break
          case 'tool_call': tui.printToolCall(ev.name, ev.args); break
          case 'tool_result': tui.printToolResult(ev.name, ev.result); break
          case 'turn_end':
            if (ev.stopReason === 'max_tokens') tui.printText('\n[output truncated by max_tokens]')
            if (ev.stopReason === 'error') tui.printText('\n[error occurred]')
            tui.printTurnEnd()
            break
        }
      }

      await session.save(context.messages)
    } catch (e) {
      console.error(`\n[error] ${(e as Error).message}`)
    } finally {
      tui.setBusy(false)
    }
  })

  tui.start()

}

// 只在直接运行时启动（非 import 时）
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
