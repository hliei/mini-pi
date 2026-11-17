import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { ContentBlock, Message } from './llm.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isBlock(value: unknown): value is ContentBlock {
  if (!isRecord(value)) return false
  switch (value.type) {
    case 'text': return typeof value.text === 'string'
    case 'tool_use': return typeof value.id === 'string' && typeof value.name === 'string' && 'input' in value
    case 'tool_result': return typeof value.tool_use_id === 'string' && typeof value.content === 'string'
    default: return false
  }
}

function readMessages(data: string): Message[] {
  const messages: Message[] = []
  for (const line of data.split('\n')) {
    if (!line.trim()) continue
    let value: unknown
    try { value = JSON.parse(line) } catch { continue }
    if (!isRecord(value)) continue
    if (value.role === 'system' && (value.section === 'skills' || value.section === 'preferences') && typeof value.content === 'string') {
      messages.push({ role: 'system', section: value.section, content: value.content })
      continue
    }
    if (value.role !== 'user' && value.role !== 'assistant') continue
    const { role, content } = value
    if (typeof content === 'string' || (Array.isArray(content) && content.every(isBlock))) {
      messages.push({ role, content })
    }
  }
  return messages
}

async function findRecentSession(dir: string) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const candidates = await Promise.all(entries.filter(e => e.isFile() && e.name.endsWith('.jsonl')).map(async e => {
    const file = path.join(dir, e.name)
    return { file, mtime: (await fs.stat(file)).mtimeMs }
  }))
  for (const { file } of candidates.sort((a, b) => b.mtime - a.mtime || b.file.localeCompare(a.file))) {
    const data = await fs.readFile(file, 'utf8')
    const messages = readMessages(data)
    // 崩溃可能留下半行；下次追加从新行开始。
    if (messages.some(message => message.role !== 'system')) {
      return { file, messages, separator: data.endsWith('\n') ? '' : '\n' }
    }
  }
}

/** dir 只存放当前工作目录的会话。空启动只分配文件名。 */
export async function openSession(dir: string, resume: boolean) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const recent = resume ? await findRecentSession(dir) : undefined
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = recent?.file ?? path.join(dir, `${timestamp}_${randomUUID()}.jsonl`)
  const messages: Message[] = recent?.messages ?? []
  let saved = messages
  let count = messages.length
  let separator = recent?.separator ?? ''

  async function save(current: Message[]) {
    // Agent 压缩时会换一个数组；普通回合沿用原数组，只追加增量。
    const replaced = current !== saved
    const pending = replaced ? current : current.slice(count)
    if (!replaced && !pending.length) return
    const data = pending.map(msg => JSON.stringify(msg) + '\n').join('')
    if (replaced) {
      const temp = `${file}.${randomUUID()}.tmp`
      try {
        await fs.writeFile(temp, data, { flag: 'wx', mode: 0o600 })
        await fs.rename(temp, file)
      } finally {
        await fs.rm(temp, { force: true })
      }
    } else {
      await fs.appendFile(file, separator + data, { flag: count ? 'a' : 'wx', mode: 0o600 })
    }
    saved = current
    count = current.length
    separator = ''
  }
  return { file, messages, save }
}
