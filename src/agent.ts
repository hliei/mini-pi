// src/agent.ts
// Agent Loop —— 整个项目的灵魂：一个 while 循环。
//
// LLM 流式回复 → 有 tool_call 就执行 → 结果放回到 Context → 继续流式
// 直到模型不再调工具（end_turn / max_tokens）或被中断（aborted / error）。

import { stream, buildAssistantMessage, buildToolResultMessage, type Model, type Context, type Message, type SystemMessage } from './llm.js'

/** 工具定义：name + 描述 + JSON Schema 参数 + execute 函数 */
export type AgentTool = {
  name: string
  description: string
  parameters: object  // JSON Schema
  execute: (args: unknown, signal?: AbortSignal) => Promise<string>
}

/** agent 对外的事件流，供 UI 消费 */
export type AgentEvent =
  | { type: 'assistant_text'; delta: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; name: string; result: string }
  | { type: 'step_end' }
  | { type: 'turn_end'; stopReason: 'end_turn' | 'max_tokens' | 'aborted' | 'error' }

/** compaction 触发阈值：消息数超过此值时压缩旧消息 */
export const COMPACT_THRESHOLD = 50
/** compaction 保留近期消息数 */
const KEEP_RECENT = 20

export function latestSystemMessages(messages: Message[]) {
  const latest = new Map<SystemMessage['section'], SystemMessage>()
  for (const message of messages) {
    if (message.role === 'system') latest.set(message.section, message)
  }
  return latest
}

/**
 * 对话压缩：当消息过多时，让 LLM 总结旧消息，用摘要替换。
 * 教的是"context 有上限，满了要压缩"——agent 自管理上下文的核心能力。
 * pi 的实现 970 行含 token 估算/cut point 边界/split turn 等，mini-pi极简为消息条数近似。
 */
async function compactContext(model: Model, context: Context, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return  // abort 时不压缩——避免空摘要损坏 context
  if (context.messages.length < COMPACT_THRESHOLD) return

  const oldMessages = context.messages.slice(0, -KEEP_RECENT)
  const recentMessages = context.messages.slice(-KEEP_RECENT)

  // 把旧消息序列化成纯文本让 LLM 总结
  const conversationText = oldMessages
    .filter(m => m.role !== 'system')
    .map(m => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
    .join('\n')

  // 用一轮非流式调用让 LLM 总结
  const summaryContext: Context = {
    systemPrompt: '请将以下对话总结为简洁的上下文摘要，保留关键决策、已做的工作和待办事项。',
    messages: [{ role: 'user', content: conversationText }],
  }

  let summary = ''
  let failed = false
  for await (const ev of stream(model, summaryContext, { signal })) {
    if (ev.type === 'text_delta') summary += ev.delta
    else if (ev.type === 'error' || ev.type === 'done' && ev.stopReason === 'aborted') { failed = true; break }
  }

  // 压缩失败时不替换 context——保留原始消息比空摘要更安全
  if (failed || !summary) return

  // 保留压缩边界处各段的有效版本及原顺序，近期更新仍留在原处。
  const latest = latestSystemMessages(oldMessages)
  context.messages = [
    ...oldMessages.filter(m => m.role === 'system' && latest.get(m.section) === m),
    { role: 'user', content: `[context summary]\n${summary}` },
    ...recentMessages,
  ]
}

/**
 * 运行 agent 循环。无 max_steps——loop 到模型说停为止。pi 同样无硬编码步数上限，但额外有 shouldStopAfterTurn 回调，mini-pi省略。
 *
 * @param model    模型配置
 * @param context  对话上下文（会被原地修改）
 * @param tools    工具注册表
 * @param signal   abort 信号
 */
export async function* runAgent(
  model: Model,
  context: Context,
  tools: AgentTool[],
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent> {
  const toolMap = new Map(tools.map(t => [t.name, t]))
  const toolDefs = tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters }))

  while (true) {
    // 0. 对话压缩：消息过多时先压缩旧消息
    await compactContext(model, context, signal)

    // 1. 流式调用 LLM，收集文本和 tool_calls
    let text = ''
    let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'aborted' = 'end_turn'
    const toolCalls: { id: string; name: string; args: unknown }[] = []

    for await (const ev of stream(model, context, { tools: toolDefs, signal })) {
      if (ev.type === 'text_delta') {
        text += ev.delta
        yield { type: 'assistant_text', delta: ev.delta }
      } else if (ev.type === 'tool_call') {
        toolCalls.push({ id: ev.id, name: ev.name, args: ev.args })
        yield { type: 'tool_call', id: ev.id, name: ev.name, args: ev.args }
      } else if (ev.type === 'done') {
        stopReason = ev.stopReason
        if (ev.stopReason === 'aborted') {
          // abort 时丢弃 tool_calls（无对应 tool_result 会导致 session 恢复后 API 报错）
          context.messages.push(buildAssistantMessage(text, []))
          yield { type: 'turn_end', stopReason: 'aborted' }
          return
        }
      } else if (ev.type === 'error') {
        context.messages.push(buildAssistantMessage(text, []))
        yield { type: 'assistant_text', delta: `\n[error] ${ev.error.message}` }
        yield { type: 'turn_end', stopReason: 'error' }
        return
      }
    }

    // 2. 把 assistant 回复塞回 context
    context.messages.push(buildAssistantMessage(text, toolCalls))

    // 3. 截断处理：max_tokens 时 tool args 可能不完整，不执行，把错误放回到 Context 让模型重发
    if (stopReason === 'max_tokens' && toolCalls.length > 0) {
      const results = toolCalls.map(tc => ({
        tool_use_id: tc.id,
        content: `error: output truncated by max_tokens, tool "${tc.name}" args may be incomplete.`,
      }))
      context.messages.push(buildToolResultMessage(results))
      for (let i = 0; i < toolCalls.length; i++) {
        yield { type: 'tool_result', id: toolCalls[i].id, name: toolCalls[i].name, result: results[i].content }
      }
      yield { type: 'step_end' }
      continue
    }

    // 4. 没有 tool_call → 循环结束
    // 畸形 API 可能返回 tool_use 但无 tool_call delta，此时视为正常结束
    const reason = stopReason === 'tool_use' ? 'end_turn' : stopReason
    if (toolCalls.length === 0) {
      yield { type: 'turn_end', stopReason: reason }
      return
    }

    // 5. 串行执行 tool_calls（pi 有 sequential/parallel 两种模式，mini-pi统一串行）
    // args 未经 parameters 验证直接传入 execute（mini-pi简化，生产应先 validate）
    const results: { tool_use_id: string; content: string }[] = []
    for (const tc of toolCalls) {
      const tool = toolMap.get(tc.name)
      let result: string
      if (!tool) {
        result = `error: tool "${tc.name}" not found`
      } else {
        try {
          result = await tool.execute(tc.args, signal)
        } catch (e) {
          result = `error: ${(e as Error).message}`
        }
      }
      results.push({ tool_use_id: tc.id, content: result })
      yield { type: 'tool_result', id: tc.id, name: tc.name, result }
      if (signal?.aborted) break
    }

    // 6. 为被 abort 跳过的 tool_call 补上错误结果（API 要求每个 tool_call 都有对应 tool_result）
    for (const tc of toolCalls.slice(results.length)) {
      results.push({ tool_use_id: tc.id, content: 'error: aborted' })
      yield { type: 'tool_result', id: tc.id, name: tc.name, result: 'error: aborted' }
    }

    // 7. 完整批次进入 Context 后再通知保存，避免落下未配对的工具调用。
    context.messages.push(buildToolResultMessage(results))
    yield { type: 'step_end' }
  }
}
