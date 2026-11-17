import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'

/** 清单只保留名称、用途和路径；模型选中后用 read_file 读正文。 */
export async function discoverSkills(): Promise<string> {
  const directories = [
    fileURLToPath(new URL('../skills/', import.meta.url)),
    path.join(homedir(), '.minipi', 'skills'),
  ]
  const skills = new Map<string, { name: string; description: string; path: string }>()
  for (const directory of directories) {
    let entries
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    const folders = entries.filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(entry => entry.name).sort()
    for (const folder of folders) {
      const file = path.join(directory, folder, 'SKILL.md')
      try {
        const text = await fs.readFile(file, 'utf8')
        const header = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
        if (!header) continue
        const fields = load(header[1])
        if (!fields || typeof fields !== 'object' || !('description' in fields)) continue
        if (typeof fields.description !== 'string' || !fields.description.trim()) continue
        const name = 'name' in fields ? fields.name : folder
        if (typeof name !== 'string' || !name.trim()) continue
        skills.set(name.trim(), { name: name.trim(), description: fields.description.trim(), path: file })
      } catch (error) {
        // 损坏的个人技能不盖掉内置版本，其他技能仍可发现。
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`跳过技能 ${file}：${(error as Error).message}`)
      }
    }
  }
  const catalog = [...skills.values()].sort((a, b) => a.name.localeCompare(b.name))
  return '当前可用技能（完整清单，以最近一次为准）：\n' + JSON.stringify(catalog)
}
