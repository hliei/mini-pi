import { afterAll, beforeEach, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import { builtinTools } from '../src/tools.js'
import { memoryFile, preferencePrompt } from '../src/memory.js'

const fixture = vi.hoisted(() => ({ dir: '' }))
vi.mock('node:os', async (load) => {
  const actual = await load<typeof os>()
  fixture.dir = await fs.mkdtemp(actual.tmpdir() + '/minipi-memory-')
  return { ...actual, homedir: () => fixture.dir }
})

const edit = builtinTools().find(tool => tool.name === 'edit')!
function remember(old_string: string, new_string: string) {
  return edit.execute({ path: memoryFile, old_string, new_string })
}

beforeEach(async () => { await fs.rm(memoryFile, { force: true }) })
afterAll(async () => { await fs.rm(fixture.dir, { recursive: true, force: true }) })

it('loads saved preferences, updates one line and preserves other preferences', async () => {
  await preferencePrompt()
  await expect(fs.stat(memoryFile)).rejects.toMatchObject({ code: 'ENOENT' })
  await remember('', '- follow-up by email')
  await remember('', '- risks first')
  await remember('', '- risks first')
  await remember('- risks first', '- conclusions first')
  const expected = '- follow-up by email\n- conclusions first\n'
  expect(await fs.readFile(memoryFile, 'utf8')).toBe(expected)
  expect(await preferencePrompt()).toContain(expected.trim())
})

it('preserves saved preferences on stale edits, competing writes and whole-file overwrites', async () => {
  await remember('', '- risks first')
  await expect(remember('- outdated', '- new')).rejects.toThrow('旧偏好')
  await fs.writeFile(memoryFile + '.tmp', 'another writer')
  await expect(remember('', '- new')).rejects.toThrow('本次未保存')
  const write = builtinTools().find(tool => tool.name === 'write_file')!
  await expect(write.execute({ path: memoryFile, content: 'replacement' })).rejects.toThrow('edit')
  expect(await fs.readFile(memoryFile, 'utf8')).toBe('- risks first\n')
  expect(await fs.readFile(memoryFile + '.tmp', 'utf8')).toBe('another writer')
})
