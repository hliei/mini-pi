import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { AgentTool } from './agent.js'
import { builtinTools } from './tools.js'
import { memoryFile } from './memory.js'
import { isKnowledgePath, knowledgeDir } from './knowledge.js'
import { builtinSkillsDir, personalSkillsDir, skillMetadata } from './skills.js'

type Snapshot = { data: string; mode: number } | null
type Change = { path: string; before: Snapshot; after: Snapshot }
export class ReflectionRecoveryError extends Error {}
export type ReflectionRecord = {
  id: string
  cwd: string
  status: 'pending' | 'complete' | 'undone'
  summary: string
  changes: Change[]
}

const personalDir = path.dirname(memoryFile)
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file)
  return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
}
const same = (a: Snapshot, b: Snapshot) => a?.data === b?.data && a?.mode === b?.mode

async function snapshot(file: string): Promise<Snapshot> {
  try {
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.nlink !== 1) throw new Error(`复盘只处理普通、非硬链接文件：${file}`)
    return { data: (await fs.readFile(file)).toString('base64'), mode: stat.mode & 0o777 }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function atomicWrite(file: string, data: string | Buffer, mode = 0o600) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temp, data, { flag: 'wx', mode })
    await fs.rename(temp, file)
  } finally { await fs.rm(temp, { force: true }) }
}

function recordDir(cwd: string) {
  return path.join(personalDir, 'evolution', createHash('sha256').update(path.resolve(cwd)).digest('hex'))
}

async function saveRecord(record: ReflectionRecord) {
  await atomicWrite(path.join(recordDir(record.cwd), record.id + '.json'), JSON.stringify(record, null, 2) + '\n')
}

/** 同时检查逻辑路径与真实路径；不能借项目目录或软链接绕过个人资料保护。 */
async function writeGuard(cwd: string) {
  const protectedNames = new Set((await fs.readdir(builtinSkillsDir)).map(name => name.toLowerCase()))
  const roots = [cwd, personalDir, builtinSkillsDir].map(root => path.resolve(root))
  async function realPath(file: string): Promise<string> {
    try { return await fs.realpath(file) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return path.join(await realPath(path.dirname(file)), path.basename(file))
    }
  }
  const realRoots = await Promise.all(roots.map(realPath))
  function permitted(file: string, [project, personal, builtin]: string[]) {
    if (inside(builtin, file)) return false
    if (inside(personal, file)) {
      const relative = path.relative(personal, file).split(path.sep)
      return relative.length === 1 && relative[0] === 'MEMORY.md' ||
        relative.length > 1 && relative[0] === 'knowledge' ||
        relative.length > 2 && relative[0] === 'skills' && !protectedNames.has(relative[1].toLowerCase())
    }
    return file !== project && inside(project, file)
  }
  async function check(file: string) {
    file = path.resolve(cwd, file)
    const resolved = await realPath(file)
    if (!permitted(file, roots) || !permitted(resolved, realRoots)) throw new Error(`复盘禁止写入此路径：${file}`)
    const rootIndex = inside(personalDir, file) ? 1 : 0
    if (resolved !== path.join(realRoots[rootIndex], path.relative(roots[rootIndex], file))) {
      throw new Error(`复盘写入路径不能经过软链接：${file}`)
    }
    return file
  }
  return { check, protectedNames }
}

async function restore(record: ReflectionRecord) {
  const guard = await writeGuard(record.cwd)
  // 先核对全部目标，再恢复；允许重试一次部分失败的恢复。
  for (const change of record.changes) {
    await guard.check(change.path)
    const current = await snapshot(change.path)
    if (!same(current, change.after) && !same(current, change.before)) {
      throw new Error(`文件在复盘后已改变，未继续恢复：${change.path}；备份 ${record.id}`)
    }
  }
  for (const change of [...record.changes].reverse()) {
    if (same(await snapshot(change.path), change.before)) continue
    if (change.before) await atomicWrite(change.path, Buffer.from(change.before.data, 'base64'), change.before.mode)
    else await fs.unlink(change.path)
  }
}

export async function openReflectionFiles(cwd: string) {
  cwd = path.resolve(cwd)
  const guard = await writeGuard(cwd)
  const record: ReflectionRecord = {
    id: new Date().toISOString().replace(/[:.]/g, '-') + '_' + randomUUID(),
    cwd, status: 'pending', summary: '', changes: [],
  }
  let storageError: unknown
  const tools = builtinTools().filter(tool => tool.name !== 'run_bash').map((tool): AgentTool => ({
    ...tool,
    async execute(args, signal) {
      signal?.throwIfAborted()
      if (!args || typeof args !== 'object' || !('path' in args) || typeof args.path !== 'string') throw new Error('需要字符串 path')
      const file = path.resolve(cwd, args.path)
      if (tool.name === 'read_file') return tool.execute({ ...args, path: file }, signal)
      await guard.check(file)
      // 知识工具还会改索引与日志，三者属于同一份恢复记录。
      const files = isKnowledgePath(file)
        ? [file, path.join(knowledgeDir, 'index.md'), path.join(knowledgeDir, 'log.md')]
        : [file]
      try {
        for (const target of new Set(files)) {
          await guard.check(target)
          const current = await snapshot(target)
          const previous = record.changes.find(change => change.path === target)
          if (previous && !same(previous.after, current)) throw new Error(`复盘期间文件已改变：${target}`)
          if (!previous) record.changes.push({ path: target, before: current, after: current })
        }
        await saveRecord(record)
      } catch (error) { storageError = error; throw error }
      try {
        signal?.throwIfAborted()
        return await tool.execute({ ...args, path: file }, signal)
      } finally {
        try {
          for (const change of record.changes.filter(change => files.includes(change.path))) change.after = await snapshot(change.path)
          await saveRecord(record)
        } catch (error) { storageError = error; throw error }
      }
    },
  }))
  tools.push({
    name: 'list_files', description: '查看目录中的直接子项，不执行命令。',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    async execute(args) {
      if (!args || typeof args !== 'object' || !('path' in args) || typeof args.path !== 'string') throw new Error('需要字符串 path')
      const entries = await fs.readdir(path.resolve(cwd, args.path), { withFileTypes: true })
      return entries.map(entry => entry.name + (entry.isDirectory() ? '/' : '')).sort().join('\n')
    },
  })
  return {
    tools,
    checkStorage() { if (storageError) throw storageError },
    async commit(summary: string, signal?: AbortSignal) {
      if (storageError) throw storageError
      record.changes = record.changes.filter(change => !same(change.before, change.after))
      for (const change of record.changes) {
        await guard.check(change.path)
        if (!same(await snapshot(change.path), change.after)) throw new Error(`复盘期间文件已改变：${change.path}`)
        if (inside(personalSkillsDir, change.path) && path.basename(change.path).toLowerCase() === 'skill.md' && change.after) {
          const metadata = skillMetadata(Buffer.from(change.after.data, 'base64').toString('utf8'), path.basename(path.dirname(change.path)))
          if (!metadata?.body || guard.protectedNames.has(metadata.name.toLowerCase())) throw new Error(`技能格式无效或使用内置名称：${change.path}`)
        }
      }
      if (!record.changes.length) return null
      signal?.throwIfAborted()
      record.summary = summary
      record.status = 'complete'
      try { await saveRecord(record) } catch (error) { record.status = 'pending'; throw error }
      try {
        const records = await listReflections(cwd)
        for (const old of records.filter(item => item.status !== 'pending').slice(10)) {
          await fs.unlink(path.join(recordDir(cwd), old.id + '.json'))
        }
      } catch (error) { console.error(`[warning] 复盘备份清理失败：${String(error)}`) }
      return record
    },
    async rollback() {
      if (record.status === 'complete') return
      // shortcut: 版本核对不等于跨进程事务；多进程共同写资料时需统一写入锁。
      try {
        await restore(record)
        await fs.rm(path.join(recordDir(cwd), record.id + '.json'), { force: true })
      } catch (error) { throw new ReflectionRecoveryError(`复盘恢复失败，保留备份 ${record.id}：${String(error)}`) }
    },
  }
}

function isSnapshot(value: unknown): value is Snapshot {
  return value === null || typeof value === 'object' && value !== null &&
    'data' in value && typeof value.data === 'string' && Buffer.from(value.data, 'base64').toString('base64') === value.data &&
    'mode' in value && typeof value.mode === 'number' && Number.isInteger(value.mode) && value.mode >= 0 && value.mode <= 0o777
}

export async function readReflection(cwd: string, id: string): Promise<ReflectionRecord> {
  if (!/^[\w-]{1,100}$/.test(id)) throw new Error('无效的复盘 ID')
  const value: unknown = JSON.parse(await fs.readFile(path.join(recordDir(cwd), id + '.json'), 'utf8'))
  if (!value || typeof value !== 'object' || !('id' in value) || value.id !== id ||
      !('cwd' in value) || value.cwd !== path.resolve(cwd) ||
      !('status' in value) || value.status !== 'pending' && value.status !== 'complete' && value.status !== 'undone' ||
      !('summary' in value) || typeof value.summary !== 'string' ||
      !('changes' in value) || !Array.isArray(value.changes) || !value.changes.every((change: unknown) =>
        change && typeof change === 'object' && 'path' in change && typeof change.path === 'string' && path.isAbsolute(change.path) &&
        'before' in change && isSnapshot(change.before) && 'after' in change && isSnapshot(change.after))) {
    throw new Error('复盘备份格式无效，未恢复任何文件')
  }
  // 上面已完整验证磁盘边界；后续使用明确的数据类型。
  return value as ReflectionRecord
}

export async function listReflections(cwd: string): Promise<ReflectionRecord[]> {
  let files: string[]
  try { files = await fs.readdir(recordDir(cwd)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return Promise.all(files.filter(file => file.endsWith('.json')).sort().reverse().map(file => readReflection(cwd, file.slice(0, -5))))
}

export async function undoReflection(cwd: string, id: string): Promise<string> {
  const record = await readReflection(cwd, id)
  if (record.status === 'undone') return `复盘 ${id} 已撤销，无需重复恢复。`
  await restore(record)
  record.status = 'undone'
  await saveRecord(record)
  return `已撤销复盘 ${id}，恢复 ${record.changes.length} 个文件。`
}

export function reflectionDiff(record: ReflectionRecord): string {
  return record.changes.map(change => {
    const before = change.before ? Buffer.from(change.before.data, 'base64').toString('utf8').split('\n') : []
    const after = change.after ? Buffer.from(change.after.data, 'base64').toString('utf8').split('\n') : []
    let start = 0
    while (start < before.length && start < after.length && before[start] === after[start]) start++
    let end = 0
    while (end < before.length - start && end < after.length - start && before.at(-end - 1) === after.at(-end - 1)) end++
    return `--- ${change.path}\n+++ ${change.path}\n` + [
      ...before.slice(start, before.length - end).map(line => '-' + line),
      ...after.slice(start, after.length - end).map(line => '+' + line),
    ].join('\n')
  }).join('\n\n')
}
