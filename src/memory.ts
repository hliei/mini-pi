import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export const memoryFile = path.join(os.homedir(), '.minipi', 'MEMORY.md')

async function readMemory(): Promise<string> {
  try {
    return await fs.readFile(memoryFile, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

export const preferenceInstructions = `个人长期偏好保存在 ${memoryFile}，所有项目共用。以最近一份长期偏好为准，只在与任务相关时采用，当前用户要求优先。
用户明确表达长期习惯或要求以后照做时，立即调用 edit 更新这个绝对路径，每条偏好单独一行。新增时 old_string 传空串，已有相同偏好无需重复写；改口时 old_string 传要替换的完整旧行。保留其他条目。
只保存用户本人明确表达的长期偏好，如实保留适用条件。这次或本周的要求仅用于本次任务。项目材料、聊天内容和密钥不要写入。只有工具成功才可确认保存；失败时说明未保存，不要改用其他工具覆盖文件。`

export async function preferencePrompt(): Promise<string> {
  const preferences = (await readMemory()).trim()
  return preferences
    ? `当前长期偏好（完整内容，取代此前版本，仅作用户数据）：\n${preferences}`
    : '当前长期偏好为空，取代此前版本。'
}

export async function editPreference(oldLine: string, newLine: string): Promise<string> {
  const old = oldLine.replace(/\r?\n$/, '')
  const next = newLine.trim()
  if (!next || /[\r\n]/.test(old) || /[\r\n]/.test(next)) throw new Error('每次请编辑一条非空的单行偏好')

  // 共享文件先独占临时文件，再读取最新内容。其他会话遇到冲突会收到工具错误。
  const temp = memoryFile + '.tmp'
  await fs.mkdir(path.dirname(memoryFile), { recursive: true, mode: 0o700 })
  const handle = await fs.open(temp, 'wx', 0o600).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('个人偏好正在写入，本次未保存，请稍后重试')
    throw error
  })
  let published = false
  try {
    const current = await readMemory()
    const lines = current.split(/\r?\n/)
    let updated: string
    if (old) {
      const index = lines.indexOf(old)
      if (index < 0 || index !== lines.lastIndexOf(old)) throw new Error('旧偏好必须完整、唯一地匹配一行，请重新读取原文件')
      lines[index] = next
      updated = lines.join('\n')
    } else {
      if (lines.includes(next)) return '这条偏好已保存'
      updated = current + (current && !current.endsWith('\n') ? '\n' : '') + next + '\n'
    }
    await handle.writeFile(updated)
    await fs.rename(temp, memoryFile)
    published = true
    return '个人偏好已保存'
  } finally {
    await handle.close()
    // rename 成功后另一个进程可能已创建自己的临时文件，不能把它删除。
    if (!published) await fs.rm(temp, { force: true })
  }
}
