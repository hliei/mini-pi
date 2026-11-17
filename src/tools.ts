// src/tools.ts
// 4 个内置工具 —— 能读写改代码并执行验证的最小集。
// 每个 tool 是纯函数：async (args) => string，不碰 agent 状态。
// 注意：mini-pi不验证 args，生产 agent 应在 execute 前用 parameters validate 参数。

import { promises as fs } from 'node:fs'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import * as path from 'node:path'
import * as os from 'node:os'
import type { AgentTool } from './agent.js'
import { editPreference, memoryFile } from './memory.js'

const execAsync = promisify(exec)

/** 工具输出截取上限（行数），超过则截取尾部并提示 */
const MAX_OUTPUT_LINES = 200

let truncateCounter = 0

/**
 * 截取工具输出：超过 maxLines 行时只保留尾部，完整输出存到临时文件。
 * 尾部优先——错误信息通常在末尾。
 */
async function truncateOutput(content: string, maxLines = MAX_OUTPUT_LINES): Promise<string> {
  const lines = content.split('\n')
  if (lines.length <= maxLines) return content
  const kept = lines.slice(-maxLines).join('\n')
  const tmpPath = path.join(os.tmpdir(), `minipi-output-${process.pid}-${truncateCounter++}.txt`)
  await fs.writeFile(tmpPath, content, 'utf-8')
  return `[output truncated: showing last ${maxLines} of ${lines.length} lines. full output: ${tmpPath}]\n${kept}`
}

/** read_file：返回文件内容（截取尾部防止超大输出） */
const readFile: AgentTool = {
  name: 'read_file',
  description: '读取文件内容。参数：path（文件路径）。大文件截取最后 200 行。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要读取的文件路径' },
    },
    required: ['path'],
  },
  execute: async (args) => {
    const { path: filePath } = args as { path: string }
    const content = await fs.readFile(filePath, 'utf-8')
    return await truncateOutput(content)
  },
}

/** write_file：覆盖写入文件 */
const writeFile: AgentTool = {
  name: 'write_file',
  description: '写入文件（覆盖）。参数：path（路径）、content（内容）',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要写入的文件路径' },
      content: { type: 'string', description: '文件内容' },
    },
    required: ['path', 'content'],
  },
  execute: async (args) => {
    const { path: filePath, content } = args as { path: string; content: string }
    if (path.resolve(filePath) === memoryFile) throw new Error('请用 edit 更新个人偏好，每次只改一条')
    await fs.mkdir(path.dirname(filePath) || '.', { recursive: true })
    await fs.writeFile(filePath, content, 'utf-8')
    return `wrote ${filePath} (${content.length} chars)`
  },
}

/** edit：局部字符串替换（精确匹配 + 唯一性校验） */
const edit: AgentTool = {
  name: 'edit',
  description: '精确替换唯一匹配的文本。编辑个人 MEMORY.md 时，old_string 留空新增一行，否则传完整旧行进行替换。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      old_string: { type: 'string', description: '要替换的唯一文本；个人 MEMORY.md 新增偏好时传空串' },
      new_string: { type: 'string', description: '替换后的文本' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  execute: async (args) => {
    if (!args || typeof args !== 'object' ||
        !('path' in args) || typeof args.path !== 'string' ||
        !('old_string' in args) || typeof args.old_string !== 'string' ||
        !('new_string' in args) || typeof args.new_string !== 'string') {
      throw new Error('edit 需要 path、old_string、new_string 三个字符串参数')
    }
    const { path: filePath, old_string, new_string } = args
    if (path.resolve(filePath) === memoryFile) return editPreference(old_string, new_string)
    const content = await fs.readFile(filePath, 'utf-8')
    const count = content.split(old_string).length - 1
    if (count === 0) throw new Error(`old_string not found in ${filePath}`)
    if (count > 1) throw new Error(`old_string matches ${count} places in ${filePath}, must be unique`)
    // 用函数替换避免 new_string 中的 $ 特殊字符（$& $` $' $1）被 String.replace 解释
    const newContent = content.replace(old_string, () => new_string)
    await fs.writeFile(filePath, newContent, 'utf-8')
    return `edited ${filePath}: replaced ${old_string.length} chars`
  },
}

/** run_bash：执行 shell 命令（截取尾部输出防止超大输出） */
const runBash: AgentTool = {
  name: 'run_bash',
  description: '执行 shell 命令。参数：command（命令字符串）。返回 stdout+stderr，截取最后 200 行。',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的 shell 命令' },
    },
    required: ['command'],
  },
  execute: async (args, signal) => {
    const { command } = args as { command: string }
    try {
      const { stdout, stderr } = await execAsync(command, { maxBuffer: 1024 * 1024, timeout: 30000, signal })
      const output = stderr ? `[stderr] ${stderr}\n[stdout] ${stdout}` : stdout
      return await truncateOutput(output)
    } catch (e: unknown) {
      if (signal?.aborted) return 'aborted'
      const err = e as NodeJS.ErrnoException & { code?: number; stdout?: string; stderr?: string }
      return `[exit ${err.code}] ${err.stderr ?? ''}${err.stdout ?? ''}`
    }
  },
}

/** 返回全部内置工具 */
export function builtinTools(): AgentTool[] {
  return [readFile, writeFile, edit, runBash]
}
