// test/cli.test.ts
// 测试 session 持久化的核心 round-trip。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { loadSession, persistSession } from '../src/cli.js'
import type { Message } from '../src/llm.js'

let tmpFile: string

beforeEach(() => { tmpFile = path.join(os.tmpdir(), `minipi-session-${Date.now()}.jsonl`) })
afterEach(async () => { await fs.rm(tmpFile, { force: true }) })

it('starts the CLI through a command symlink', async () => {
  await fs.symlink(new URL('../src/cli.ts', import.meta.url), tmpFile)
  const result = spawnSync(process.execPath, ['--import', 'tsx', tmpFile], {
    encoding: 'utf8',
    env: { ...process.env, MINIPI_API_KEY: '' },
    timeout: 5000,
  })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('请在 .env 中设置 MINIPI_API_KEY')
})

describe('.env startup configuration', () => {
  let dir: string
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'minipi-env-')) })
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

  it.each([
    { name: 'loads .env', file: true, exported: false, status: 0 },
    { name: 'keeps exported values', file: true, exported: true, status: 0 },
    { name: 'allows exports without .env', file: false, exported: true, status: 0 },
    { name: 'rejects a missing key', file: false, exported: false, status: 1 },
  ])('$name', async ({ file, exported, status }) => {
    const values = {
      MINIPI_API_KEY: 'test-key',
      MINIPI_MODEL: 'test-model',
      MINIPI_BASE_URL: 'https://example.invalid/v1',
    }
    if (file) {
      await fs.writeFile(path.join(dir, '.env'), Object.entries(values)
        .map(([key, value]) => `${key}="${value}"`).join('\n'))
    }
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir }
    for (const key of Object.keys(values)) delete env[key]
    if (exported) Object.assign(env, values, { MINIPI_MODEL: 'exported-model' })

    // Read the child environment after CLI startup without calling a real model.
    const probe = `process.on('exit', () => console.log('CONFIG:' + JSON.stringify(
      Object.fromEntries(${JSON.stringify(Object.keys(values))}.map(key => [key, process.env[key]]))
    )))`
    const result = spawnSync(process.execPath, [
      '--import', createRequire(import.meta.url).resolve('tsx'),
      '--import', `data:text/javascript,${encodeURIComponent(probe)}`,
      fileURLToPath(new URL('../src/cli.ts', import.meta.url)),
    ], { cwd: dir, env, encoding: 'utf8', input: '', timeout: 5000 })

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(status)
    const config = JSON.parse(result.stdout.split('CONFIG:')[1])
    expect(config).toEqual(exported ? { ...values, MINIPI_MODEL: 'exported-model' } : file ? values : {})
    if (status === 0) expect(result.stdout).toContain('> ')
    else expect(result.stderr).toContain('请在 .env 中设置 MINIPI_API_KEY')
  })
})

describe('session persistence', () => {
  it('persist → load round-trip', async () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]
    await persistSession(messages, tmpFile)
    expect(await loadSession(tmpFile)).toEqual(messages)
  })

  it('rewrites the file after context compaction before appending new messages', async () => {
    await fs.writeFile(tmpFile, '')
    await loadSession(tmpFile)

    const initial: Message[] = [
      { role: 'user', content: 'old-1' },
      { role: 'assistant', content: 'old-2' },
      { role: 'user', content: 'old-3' },
    ]
    const compacted: Message[] = [
      { role: 'user', content: '[context summary]' },
      { role: 'assistant', content: 'recent' },
    ]
    const afterCompaction: Message[] = [
      ...compacted,
      { role: 'user', content: 'new prompt' },
    ]

    await persistSession(initial, tmpFile)
    await loadSession(tmpFile)
    await persistSession(compacted, tmpFile)
    await persistSession(afterCompaction, tmpFile)

    expect(await loadSession(tmpFile)).toEqual(afterCompaction)
  })
})
