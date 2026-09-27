import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCodexBinary } from '../src/codex.js'
const local = await mkdtemp(join(tmpdir(), 'codex-path-'))
const root = join(local, 'OpenAI', 'Codex', 'bin')
const current = join(root, 'current', 'codex.exe')
await mkdir(join(root, 'current'), { recursive: true })
await writeFile(current, '')
assert.equal(await resolveCodexBinary(join(root, 'removed', 'codex.exe'), local), current)
assert.equal(await resolveCodexBinary(current, local), current)
assert.equal(await resolveCodexBinary('codex', local), 'codex')
assert.equal(await resolveCodexBinary(join(local, 'custom.exe'), local), join(local, 'custom.exe'))
console.log('CODEX-PATH-OK')
