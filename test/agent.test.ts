// test/agent.test.ts
// 测试 agent loop 的核心路径：纯文本回复、tool_call 执行后把结果放回到 Context、未知 tool 报错。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { StreamEvent, Model, Context } from '../src/llm.js'

const { mockStreamFn } = vi.hoisted(() => ({
  mockStreamFn: vi.fn(async function* (): AsyncGenerator<StreamEvent> {
    yield { type: 'done', stopReason: 'end_turn' }
  }),
}))

vi.mock('../src/llm.js', () => ({
  stream: mockStreamFn,
  buildAssistantMessage: (text: string, toolCalls: { id: string; name: string; args: unknown }[]) => {
    const content: unknown[] = []
    if (text) content.push({ type: 'text', text })
    for (const tc of toolCalls) content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args })
    return { role: 'assistant', content }
  },
  buildToolResultMessage: (results: { tool_use_id: string; content: string }[]) => ({
    role: 'user',
    content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.tool_use_id, content: r.content })),
  }),
}))

import { runAgent, type AgentTool, type AgentEvent } from '../src/agent.js'

beforeEach(() => { mockStreamFn.mockClear() })

const model: Model = { apiKey: 'k', model: 'test' }

describe('runAgent', () => {
  it('压缩时按原顺序保留边界前各段的最后版本和边界后的更新', async () => {
    const latest = { role: 'system', section: 'skills', content: '新版技能清单' } as const
    const prefs = { role: 'system', section: 'preferences', content: '风险优先' } as const
    const cleared = { ...prefs, content: '当前长期偏好为空，取代此前版本。' }
    const knowledge = { role: 'system', section: 'knowledge', content: '当前知识索引' } as const
    const ctx: Context = { messages: [
      { ...latest, content: '旧版技能清单' }, { ...prefs, content: '结论优先' }, prefs, latest,
      { ...knowledge, content: '旧索引' }, knowledge,
      ...Array.from({ length: 48 }, (_, i) => ({ role: 'user' as const, content: String(i) })),
      cleared,
    ] }
    mockStreamFn.mockImplementation(async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'text_delta', delta: '完成' }
      yield { type: 'done', stopReason: 'end_turn' }
    })
    for await (const _ of runAgent(model, ctx, [])) { /* 消费摘要和正常回复 */ }
    expect(ctx.messages.slice(0, 5)).toEqual([
      prefs, latest, knowledge, { role: 'user', content: '[context summary]\n完成' }, { role: 'user', content: '29' },
    ])
    expect(ctx.messages.at(-2)).toEqual(cleared)
  })

  it('纯文本回复：一轮就结束', async () => {
    mockStreamFn.mockImplementation(async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'text_delta', delta: 'Hello' }
      yield { type: 'done', stopReason: 'end_turn' }
    })

    const ctx: Context = { messages: [] }
    const events: AgentEvent[] = []
    for await (const e of runAgent(model, ctx, [] as AgentTool[])) events.push(e)

    expect(events.find(e => e.type === 'assistant_text')).toEqual({ type: 'assistant_text', delta: 'Hello' })
    expect(events.at(-1)).toEqual({ type: 'turn_end', stopReason: 'end_turn' })
    expect(ctx.messages).toHaveLength(1)
  })

  it('tool_call → 执行 → 把结果放回到 Context → 下一轮纯文本', async () => {
    const echoTool: AgentTool = {
      name: 'echo',
      description: 'echo back',
      parameters: { type: 'object', properties: {} },
      execute: async (args) => `ECHO: ${(args as { text: string }).text}`,
    }

    let round = 0
    mockStreamFn.mockImplementation(async function* (): AsyncGenerator<StreamEvent> {
      if (round === 0) {
        yield { type: 'tool_call', id: 't1', name: 'echo', args: { text: 'hi' } }
        yield { type: 'done', stopReason: 'tool_use' }
      } else {
        yield { type: 'text_delta', delta: 'Done' }
        yield { type: 'done', stopReason: 'end_turn' }
      }
      round++
    })

    const ctx: Context = { messages: [] }
    const events: AgentEvent[] = []
    for await (const e of runAgent(model, ctx, [echoTool])) events.push(e)

    expect(events.map(e => e.type)).toEqual(['tool_call', 'tool_result', 'step_end', 'assistant_text', 'turn_end'])
    const tr = events.find(e => e.type === 'tool_result')
    expect(tr?.result).toBe('ECHO: hi')
    // 3 条消息：assistant(tool_use) + user(tool_result) + assistant(text)
    expect(ctx.messages).toHaveLength(3)
  })

  it('未知 tool 名 → 把报错结果放回到 Context', async () => {
    let round = 0
    mockStreamFn.mockImplementation(async function* (): AsyncGenerator<StreamEvent> {
      if (round === 0) {
        yield { type: 'tool_call', id: 't1', name: 'nope', args: {} }
        yield { type: 'done', stopReason: 'tool_use' }
      } else {
        yield { type: 'text_delta', delta: 'ok' }
        yield { type: 'done', stopReason: 'end_turn' }
      }
      round++
    })

    const events: AgentEvent[] = []
    for await (const e of runAgent(model, { messages: [] }, [] as AgentTool[])) events.push(e)

    const tr = events.find(e => e.type === 'tool_result')
    expect(tr?.result).toContain('not found')
  })

  it.each(['success', 'truncated', 'aborted'] as const)('完整批次才可保存：%s', async (mode) => {
    const ctrl = new AbortController()
    const execute = vi.fn(async () => {
      if (mode === 'aborted') ctrl.abort()
      return '已核对'
    })
    mockStreamFn.mockImplementation(async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'done', stopReason: 'end_turn' }
    }).mockImplementationOnce(async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'tool_call', id: 't1', name: 'check', args: {} }
      yield { type: 'tool_call', id: 't2', name: 'check', args: {} }
      yield { type: 'done', stopReason: mode === 'truncated' ? 'max_tokens' : 'tool_use' }
    })
    const ctx: Context = { messages: [{ role: 'user', content: '核对提交和里程碑' }] }
    const events: AgentEvent[] = []
    for await (const event of runAgent(model, ctx, [{ name: 'check', description: '', parameters: {}, execute }], ctrl.signal)) {
      events.push(event)
      if (event.type === 'step_end') break
    }
    expect(events.map(event => event.type)).toEqual(['tool_call', 'tool_call', 'tool_result', 'tool_result', 'step_end'])
    expect(mockStreamFn).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledTimes(mode === 'truncated' ? 0 : mode === 'aborted' ? 1 : 2)
    expect(ctx.messages).toHaveLength(3)
    expect(ctx.messages.at(-1)).toEqual({ role: 'user', content: [
      { type: 'tool_result', tool_use_id: 't1', content: mode === 'truncated' ? expect.stringContaining('output truncated') : '已核对' },
      { type: 'tool_result', tool_use_id: 't2', content: mode === 'truncated' ? expect.stringContaining('output truncated') : mode === 'aborted' ? 'error: aborted' : '已核对' },
    ] })
  })
})
