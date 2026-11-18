import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { builtinTools } from '../src/tools.js'
import { knowledgeDir, knowledgePrompt } from '../src/knowledge.js'

const fixture = vi.hoisted(() => ({ dir: '' }))
vi.mock('node:os', async (load) => {
  const actual = await load<typeof os>()
  fixture.dir = await fs.mkdtemp(path.join(actual.tmpdir(), 'minipi-knowledge-'))
  return { ...actual, homedir: () => fixture.dir }
})

const write = builtinTools().find(tool => tool.name === 'write_file')!
const edit = builtinTools().find(tool => tool.name === 'edit')!
const read = builtinTools().find(tool => tool.name === 'read_file')!
const file = path.join(knowledgeDir, 'project-a', 'release.md')
const page = `---
title: 发布流程
scope: 项目 A
summary: 灰度完成仍需确认全量发布
change: 整理发布说明
sources:
  - source: 用户在本次对话中提供的发布说明
    date: "2026-11-18"
    quote: 灰度完成表示小范围验证结束，不等于全量发布。
---
# 发布流程
只确认灰度完成，不能推断已全量发布。
`
const save = (content = page) => write.execute({ path: file, content })

beforeEach(async () => { await fs.rm(knowledgeDir, { recursive: true, force: true }) })
afterEach(() => { vi.restoreAllMocks() })
afterAll(async () => { await fs.rm(fixture.dir, { recursive: true, force: true }) })

it('saves evidence, discovers pages without injecting bodies, and does not duplicate successful retries', async () => {
  expect(await knowledgePrompt()).toContain('知识库为空')
  await expect(fs.stat(knowledgeDir)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await save()).toContain('变更日志已保存')
  expect(await read.execute({ path: file })).toBe(page)
  const log = await fs.readFile(path.join(knowledgeDir, 'log.md'), 'utf8')
  await save()
  expect(await fs.readFile(path.join(knowledgeDir, 'log.md'), 'utf8')).toBe(log)
  const index = await knowledgePrompt()
  expect(index).toContain('project-a/release.md')
  expect(index).toContain('项目 A')
  expect(index).not.toContain('小范围验证结束')
  await edit.execute({ path: file, old_string: '整理发布说明', new_string: '补充发布说明的出处' })
  expect(await fs.readFile(file, 'utf8')).toContain('quote: 灰度完成')
  expect(await fs.readFile(path.join(knowledgeDir, 'log.md'), 'utf8')).toContain('补充发布说明的出处')
})

it('rejects invalid pages, stale edits, overwrites and reserved files without losing saved data', async () => {
  await save()
  await expect(save(page.replace('quote:', 'missing:'))).rejects.toThrow('已存在')
  await expect(edit.execute({ path: file, old_string: 'quote:', new_string: 'missing:' })).rejects.toThrow('sources')
  await expect(edit.execute({ path: file, old_string: '旧的全量发布规则', new_string: '新规则' })).rejects.toThrow('重新读取')
  await expect(edit.execute({ path: file, old_string: '', new_string: '覆盖' })).rejects.toThrow('非空')
  for (const reserved of ['index.md', 'log.md']) {
    await expect(write.execute({ path: path.join(knowledgeDir, reserved), content: '覆盖' })).rejects.toThrow('程序维护')
  }
  expect(await fs.readFile(file, 'utf8')).toBe(page)
  await expect(write.execute({ path: path.join(knowledgeDir, 'invalid.md'), content: '没有出处' })).rejects.toThrow('sources')
  await expect(fs.stat(path.join(knowledgeDir, 'invalid.md'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('preserves the published page and index when replacement fails', async () => {
  await save()
  const index = await fs.readFile(path.join(knowledgeDir, 'index.md'), 'utf8')
  vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('磁盘写入失败'))
  await expect(edit.execute({ path: file, old_string: '整理发布说明', new_string: '更新发布说明' })).rejects.toThrow('磁盘写入失败')
  expect(await fs.readFile(file, 'utf8')).toBe(page)
  expect(await fs.readFile(path.join(knowledgeDir, 'index.md'), 'utf8')).toBe(index)
  expect((await fs.readdir(path.dirname(file))).filter(name => name.endsWith('.tmp'))).toEqual([])
  expect(await save()).toContain('索引已更新')
})

it('retains saved pages after index or log failures and repairs only missing work', async () => {
  await fs.mkdir(path.join(knowledgeDir, 'index.md'), { recursive: true })
  expect(await save()).toContain('部分完成：索引更新失败')
  expect(await fs.readFile(file, 'utf8')).toBe(page)
  const log = await fs.readFile(path.join(knowledgeDir, 'log.md'), 'utf8')
  expect(await knowledgePrompt()).toContain('索引不可用')
  await fs.rmdir(path.join(knowledgeDir, 'index.md'))
  expect(await knowledgePrompt()).toContain('project-a/release.md')
  await save()
  expect(await fs.readFile(path.join(knowledgeDir, 'log.md'), 'utf8')).toBe(log)

  await fs.unlink(path.join(knowledgeDir, 'log.md'))
  await fs.mkdir(path.join(knowledgeDir, 'log.md'))
  const updated = page.replace('整理发布说明', '核对发布条件')
  expect(await edit.execute({ path: file, old_string: page, new_string: updated })).toContain('部分完成：变更日志保存失败')
  expect(await fs.readFile(file, 'utf8')).toBe(updated)
  await fs.rmdir(path.join(knowledgeDir, 'log.md'))
  expect(await save(updated)).toContain('变更日志已保存')
  const repaired = await fs.readFile(path.join(knowledgeDir, 'log.md'), 'utf8')
  await save(updated)
  expect(await fs.readFile(path.join(knowledgeDir, 'log.md'), 'utf8')).toBe(repaired)
})

it('coordinates competing writers and never removes another writer’s lock', async () => {
  await save()
  const edits = await Promise.allSettled(['修改 A', '修改 B'].map(new_string =>
    edit.execute({ path: file, old_string: '整理发布说明', new_string })))
  expect(edits.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(edits.filter(result => result.status === 'rejected')).toHaveLength(1)
  const saved = await fs.readFile(file, 'utf8')
  await fs.writeFile(path.join(knowledgeDir, '.lock'), 'another writer')
  await expect(save()).rejects.toThrow('正在更新')
  expect(await fs.readFile(file, 'utf8')).toBe(saved)
  expect(await fs.readFile(path.join(knowledgeDir, '.lock'), 'utf8')).toBe('another writer')
})

it('does not write through symlinks into source documents', async () => {
  const source = path.join(fixture.dir, 'source.md')
  await fs.writeFile(source, '原始资料')
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.symlink(source, file)
  await expect(save()).rejects.toThrow('软链接')
  expect(await fs.readFile(source, 'utf8')).toBe('原始资料')
})

it('reports malformed external pages instead of treating the old index as current', async () => {
  await save()
  const index = await fs.readFile(path.join(knowledgeDir, 'index.md'), 'utf8')
  await fs.writeFile(path.join(knowledgeDir, 'broken.md'), '缺少出处')
  expect(await knowledgePrompt()).toContain('索引不可用')
  expect(await fs.readFile(path.join(knowledgeDir, 'index.md'), 'utf8')).toBe(index)
  await fs.unlink(path.join(knowledgeDir, 'broken.md'))
  await fs.unlink(file)
  expect(await knowledgePrompt()).not.toContain('project-a/release.md')
})
