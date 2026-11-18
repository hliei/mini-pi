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
import { latestSystemMessages, runAgent } from './agent.js'
import { Tui } from './tui.js'
import { builtinTools } from './tools.js'
import { openSession } from './session.js'
import { preferenceInstructions, preferencePrompt } from './memory.js'
import { discoverSkills } from './skills.js'
import { knowledgeInstructions, knowledgePrompt } from './knowledge.js'
import { createEvolution, reflectionUndoTool } from './evolution.js'
import { listReflections, readReflection, reflectionDiff, undoReflection } from './evolution-files.js'
import type { Model, Context } from './llm.js'

/** 固定 system prompt */
const SYSTEM_PROMPT = `你是一个编码助手。用提供的工具读写文件和执行命令来完成任务。先阅读再修改，修改后可运行命令验证。
多步任务开始执行时简述接下来的操作，过程中在关键进展处说明结果及依据。宣布要执行的操作应在同一轮实际调用工具，持续推进到完成或需要用户补充输入；简单问题直接回答。
根据工具结果区分已完成与未完成。缺材料或工具失败时，说明已完成部分、缺口、原因和继续条件；能独立完成的部分继续处理，必要输入缺失时等待用户补充，不把部分完成说成全部完成。续聊时利用已有记录继续，按需重新核对资料。
按最近的技能清单判断任务。若用途匹配，选最相关的一项，用 read_file 读取清单给出的完整路径，再按正文执行。若读取失败，本次技能任务就此结束，直接向用户报告工具返回的完整路径和失败原因，不再猜测步骤或改用其他工具执行。无匹配时直接处理，不读取技能。
用户明确要求撤销复盘时，从对应 [EVOLUTION] 记录取 id 调用 undo_reflection，不要用文件工具手动恢复。`

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
  const evolutionEnabled = process.env.MINIPI_SELF_EVOLUTION ?? 'true'
  if (evolutionEnabled !== 'true' && evolutionEnabled !== 'false') throw new Error('MINIPI_SELF_EVOLUTION 需要 true 或 false')

  // 用路径摘要区分工作目录，避免长路径或目录名中的特殊字符影响存储。
  const cwdKey = createHash('sha256').update(process.cwd()).digest('hex')
  const dir = path.join(os.homedir(), '.minipi', 'sessions', cwdKey)
  const session = await openSession(dir, values.continue === true)
  let skillPrompt = await discoverSkills()
  const context: Context = {
    systemPrompt: SYSTEM_PROMPT + '\n\n' + preferenceInstructions + '\n\n' + knowledgeInstructions,
    messages: session.messages,
  }

  const tui = new Tui()
  let foreground = false
  const refreshSkills = async () => { skillPrompt = await discoverSkills() }
  const evolution = createEvolution(model, context, process.cwd(), async (record) => {
    const notice = `[EVOLUTION] id=${record.id}\n${record.summary}\n` +
      record.changes.map(change => change.path).join('\n') +
      `\n查看：/reflect show ${record.id}\n撤销：/reflect undo ${record.id}`
    context.messages.push({ role: 'assistant', content: notice })
    try { await session.save(context.messages) } catch (error) {
      console.error(`[warning] 复盘已应用，通知保存失败：${String(error)}`)
    }
    try { await refreshSkills() } catch (error) {
      console.error(`[warning] 复盘已应用，技能清单刷新失败，请 /reload：${String(error)}`)
    }
    if (foreground) tui.printText('\n' + notice + '\n')
    else tui.notify(notice)
  })
  const tools = [...builtinTools(), reflectionUndoTool(process.cwd(), refreshSkills)]
  const timer = evolutionEnabled === 'true' ? setInterval(() => {
    void evolution.tick().catch(error => tui.notify(`[error] 自动复盘失败：${String(error)}`))
  }, 60_000) : undefined
  timer?.unref()
  tui.onClose(() => {
    clearInterval(timer)
    if (!foreground) void evolution.close().catch(error => console.error(`[error] 复盘退出恢复失败：${String(error)}`))
  })

  // 每轮：保存用户输入 → runAgent → 显示进展并保存完整批次 → 保存最终回复
  tui.onPrompt(async (text) => {
    let countTurn = false
    foreground = true
    try {
      tui.setBusy(true)
      await evolution.beginTurn()
      if (text === '/reload') {
        skillPrompt = await discoverSkills()
        tui.printText('技能清单已刷新。\n')
        return
      }
      if (text === '/reflect' || text.startsWith('/reflect ')) {
        const [, command, id, extra] = text.split(/\s+/)
        if (!command) {
          tui.onAbort(() => { void evolution.cancel().catch(() => {}) }) // 外层 await 负责报告恢复错误。
          if (!await evolution.run()) tui.printText('复盘结束，未应用修改。\n')
        } else if (command === 'list' && !id) {
          const records = await listReflections(process.cwd())
          tui.printText(records.map(record => `${record.id} [${record.status}] ${record.summary}`).join('\n') + (records.length ? '\n' : '暂无复盘记录。\n'))
        } else if (command === 'show' && id && !extra) {
          tui.printText(reflectionDiff(await readReflection(process.cwd(), id)) + '\n')
        } else if (command === 'undo' && id && !extra) {
          const result = await undoReflection(process.cwd(), id)
          await refreshSkills()
          context.messages.push({ role: 'assistant', content: `[EVOLUTION] ${result}` })
          await session.save(context.messages)
          tui.printText(result + '\n')
        } else tui.printText('用法：/reflect | /reflect list | /reflect show <id> | /reflect undo <id>\n')
        return
      }
      const ctrl = new AbortController()
      tui.onAbort(() => ctrl.abort())  // 每轮新建 AbortController，需重新注册回调指向新的 controller
      const previousLength = context.messages.length
      try {
        const current = { skills: skillPrompt, preferences: await preferencePrompt(), knowledge: await knowledgePrompt() }
        const latest = latestSystemMessages(context.messages)
        for (const section of ['skills', 'preferences', 'knowledge'] as const) {
          if (latest.get(section)?.content !== current[section]) {
            context.messages.push({ role: 'system', section, content: current[section] })
          }
        }
      } finally {
        // 即使偏好读取失败，用户输入仍可续聊；落盘失败则回退本轮追加。
        context.messages.push({ role: 'user', content: text })
        try {
          await session.save(context.messages)
          countTurn = true
        } catch (e) {
          context.messages.length = previousLength
          throw e
        }
      }
      for await (const ev of runAgent(model, context, tools, ctrl.signal)) {
        switch (ev.type) {
          case 'assistant_text': tui.printText(ev.delta); break
          case 'tool_call': tui.printToolCall(ev.name, ev.args); break
          case 'tool_result': tui.printToolResult(ev.name, ev.result); break
          case 'step_end':
            try {
              await session.save(context.messages)
            } catch (e) {
              // 保留内存中的结果继续执行，后续保存重试未落盘的消息。
              console.error(`\n[warning] 会话进度保存失败，后续保存将重试：${e instanceof Error ? e.message : String(e)}`)
            }
            break
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
      evolution.endTurn(countTurn)
      foreground = false
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
