import { afterAll, beforeEach, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { openReflectionFiles, listReflections, undoReflection, readReflection, reflectionDiff } from '../src/evolution-files.js'
import { memoryFile } from '../src/memory.js'
import { knowledgeDir } from '../src/knowledge.js'
import { builtinSkillsDir, personalSkillsDir, discoverSkills } from '../src/skills.js'

const fixture = vi.hoisted(() => ({ dir: '' }))
vi.mock('node:os', async (load) => {
  const actual = await load<typeof os>()
  fixture.dir = await fs.realpath(await fs.mkdtemp(actual.tmpdir() + '/minipi-evolution-files-'))
  return { ...actual, homedir: () => fixture.dir }
})

const cwd = path.join(fixture.dir, 'project')
const skill = path.join(personalSkillsDir, 'my-weekly-report', 'SKILL.md')
const skillText = '---\nname: my-weekly-report\ndescription: 个人周报\n---\n按提交写周报。\n'
const page = '---\ntitle: 发布流程\nscope: 项目 A\nsummary: 灰度不是全量\nchange: 补漏\nsources:\n  - source: 用户资料\n    date: "2026-11-18"\n    quote: 灰度完成后还需审批\n---\n灰度之后需要审批。\n'

beforeEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(fixture.dir, { recursive: true, force: true })
  await fs.mkdir(cwd, { recursive: true })
  await fs.mkdir(path.dirname(skill), { recursive: true })
  await fs.writeFile(skill, skillText, { mode: 0o640 })
})
afterAll(async () => { await fs.rm(fixture.dir, { recursive: true, force: true }) })

it('records every actual file change, discovers new skills and restores content, creations and permissions', async () => {
  await fs.writeFile(memoryFile, '标明日期\n')
  const files = await openReflectionFiles(cwd)
  const edit = files.tools.find(tool => tool.name === 'edit')!
  const write = files.tools.find(tool => tool.name === 'write_file')!
  await edit.execute({ path: skill, old_string: '按提交写周报。', new_string: '排除合并提交，再写周报。' })
  const created = path.join(personalSkillsDir, 'release-check', 'SKILL.md')
  await write.execute({ path: created, content: '---\nname: release-check\ndescription: 检查发布\n---\n核实批准记录。\n' })
  await edit.execute({ path: memoryFile, old_string: '', new_string: '风险优先' })
  const knowledge = path.join(knowledgeDir, 'release.md')
  await write.execute({ path: knowledge, content: page })
  await write.execute({ path: 'report.md', content: '完成用户要求的报告' })
  const record = await files.commit('修订周报并补漏资料')
  expect(record?.changes).toHaveLength(7)
  expect(await discoverSkills()).toContain('release-check')
  expect(reflectionDiff(record!)).toContain('+排除合并提交，再写周报。')
  expect((await listReflections(cwd))[0]).toEqual(record)
  await undoReflection(cwd, record!.id)
  expect(await fs.readFile(skill, 'utf8')).toBe(skillText)
  expect((await fs.stat(skill)).mode & 0o777).toBe(0o640)
  expect(await fs.readFile(memoryFile, 'utf8')).toBe('标明日期\n')
  for (const file of [created, knowledge, path.join(knowledgeDir, 'index.md'), path.join(knowledgeDir, 'log.md'), path.join(cwd, 'report.md')]) {
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' })
  }
  expect(await undoReflection(cwd, record!.id)).toContain('无需重复')
})

it('rejects protected, outside, symlink and hard-link writes without changing their targets', async () => {
  const files = await openReflectionFiles(cwd)
  const write = files.tools.find(tool => tool.name === 'write_file')!
  expect(files.tools.map(tool => tool.name)).not.toContain('run_bash')
  const outside = path.join(fixture.dir, 'outside.txt')
  await fs.writeFile(outside, 'original')
  await fs.symlink(fixture.dir, path.join(cwd, 'escape'))
  await fs.link(outside, path.join(cwd, 'hard-link'))
  for (const file of [outside, '../outside.txt', 'escape/outside.txt', 'hard-link',
    path.join(builtinSkillsDir, 'weekly-report', 'SKILL.md'),
    path.join(personalSkillsDir, 'WEEKLY-REPORT', 'SKILL.md'),
    path.join(fixture.dir, '.minipi', 'sessions', 'session.jsonl'),
    path.join(fixture.dir, '.minipi', 'evolution', 'fake.json'),
    path.join(fixture.dir, '.minipi', 'config.json')]) {
    await expect(write.execute({ path: file, content: 'bad' })).rejects.toThrow()
  }
  expect(await fs.readFile(outside, 'utf8')).toBe('original')
  await files.rollback()
})

it('fails closed when the backup cannot be published', async () => {
  const rename = fs.rename.bind(fs)
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to).endsWith('.json')) throw new Error('backup unavailable')
    return rename(from, to)
  })
  const files = await openReflectionFiles(cwd)
  await expect(files.tools.find(tool => tool.name === 'write_file')!.execute({ path: skill, content: 'lost' })).rejects.toThrow('backup unavailable')
  expect(await fs.readFile(skill, 'utf8')).toBe(skillText)
  await files.rollback()
})

it('restores a partially failed write from the durable before-image', async () => {
  const writeFile = fs.writeFile.bind(fs)
  vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, options) => {
    if (String(file) === skill) { await writeFile(file, 'partial'); throw new Error('injected disk error') }
    return writeFile(file, data, options)
  })
  const files = await openReflectionFiles(cwd)
  await expect(files.tools.find(tool => tool.name === 'write_file')!.execute({ path: skill, content: skillText + 'new' })).rejects.toThrow('injected disk error')
  await files.rollback()
  expect(await fs.readFile(skill, 'utf8')).toBe(skillText)
})

it('restores writes if the completed record cannot be saved', async () => {
  const files = await openReflectionFiles(cwd)
  await files.tools.find(tool => tool.name === 'write_file')!.execute({ path: skill, content: skillText + '新增步骤。\n' })
  const rename = fs.rename.bind(fs)
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to).endsWith('.json')) throw new Error('commit unavailable')
    return rename(from, to)
  })
  await expect(files.commit('修订技能')).rejects.toThrow('commit unavailable')
  await files.rollback()
  expect(await fs.readFile(skill, 'utf8')).toBe(skillText)
})

it('keeps a recovery record and reports failure when restoring a file fails', async () => {
  const files = await openReflectionFiles(cwd)
  await files.tools.find(tool => tool.name === 'write_file')!.execute({ path: skill, content: skillText + '新增步骤。\n' })
  const rename = fs.rename.bind(fs)
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to) === skill) throw new Error('restore unavailable')
    return rename(from, to)
  })
  await expect(files.rollback()).rejects.toThrow('复盘恢复失败，保留备份')
  const [record] = await listReflections(cwd)
  expect(record.status).toBe('pending')
  vi.restoreAllMocks()
  await undoReflection(cwd, record.id)
  expect(await fs.readFile(skill, 'utf8')).toBe(skillText)
})

it('checks all files before undo so a later human edit prevents any restore', async () => {
  const files = await openReflectionFiles(cwd)
  const write = files.tools.find(tool => tool.name === 'write_file')!
  await write.execute({ path: 'one.md', content: 'one' })
  await write.execute({ path: 'two.md', content: 'two' })
  const record = await files.commit('补写两个文件')
  await fs.writeFile(path.join(cwd, 'two.md'), 'later edit')
  await expect(undoReflection(cwd, record!.id)).rejects.toThrow('已改变')
  expect(await fs.readFile(path.join(cwd, 'one.md'), 'utf8')).toBe('one')
  expect(await fs.readFile(path.join(cwd, 'two.md'), 'utf8')).toBe('later edit')
})

it('validates disk records and rechecks their paths before restoring', async () => {
  const files = await openReflectionFiles(cwd)
  await files.tools.find(tool => tool.name === 'write_file')!.execute({ path: 'result.md', content: 'new' })
  const record = (await files.commit('补写报告'))!
  const root = path.join(fixture.dir, '.minipi', 'evolution')
  const [projectKey] = await fs.readdir(root)
  const file = path.join(root, projectKey, record.id + '.json')
  record.changes[0].path = path.join(fixture.dir, 'outside.txt')
  await fs.writeFile(file, JSON.stringify(record))
  await expect(undoReflection(cwd, record.id)).rejects.toThrow('禁止写入')
  await expect(readReflection(cwd, '../../outside')).rejects.toThrow('无效')
  await fs.writeFile(file, JSON.stringify({ ...record, changes: [null] }))
  await expect(readReflection(cwd, record.id)).rejects.toThrow('格式无效')
  expect(await fs.readFile(path.join(cwd, 'result.md'), 'utf8')).toBe('new')
})

it.each(['missing metadata', '---\nname: weekly-report\ndescription: override\n---\nbody'])('rolls back invalid or disguised built-in skills: %s', async (content) => {
  const files = await openReflectionFiles(cwd)
  await files.tools.find(tool => tool.name === 'write_file')!.execute({ path: skill, content })
  await expect(files.commit('修改技能')).rejects.toThrow('技能格式无效')
  await files.rollback()
  expect(await fs.readFile(skill, 'utf8')).toBe(skillText)
})

it('keeps ten completed records and discards unchanged attempts', async () => {
  const ids: string[] = []
  for (let i = 0; i < 11; i++) {
    const files = await openReflectionFiles(cwd)
    await files.tools.find(tool => tool.name === 'write_file')!.execute({ path: 'result.md', content: String(i) })
    ids.push((await files.commit('更新报告'))!.id)
  }
  expect(await listReflections(cwd)).toHaveLength(10)
  await expect(readReflection(cwd, ids[0])).rejects.toMatchObject({ code: 'ENOENT' })
  const files = await openReflectionFiles(cwd)
  await files.tools.find(tool => tool.name === 'write_file')!.execute({ path: 'result.md', content: '10' })
  expect(await files.commit('没有改动')).toBeNull()
  await files.rollback()
  expect(await listReflections(cwd)).toHaveLength(10)
})
