import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const exec = promisify(execFile)
const entrypoint = fileURLToPath(new URL('../../../../../docker/platform/entrypoint.sh', import.meta.url))

it('acquires a nonblocking lifetime lock before launching the node and propagates lock conflict', async () => {
  const root = await mkdtemp(join(tmpdir(), 'node-lock-entry-'))
  try {
    const output = join(root, 'arguments')
    await writeFile(join(root, 'flock'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$LOCK_TEST_OUTPUT"\nexit 75\n', { mode: 0o700 })
    await expect(exec('bash', [entrypoint, 'node-agent'], {
      env: { ...process.env, PATH: `${root}:${process.env.PATH}`, HOST_STORAGE_ROOT: root, LOCK_TEST_OUTPUT: output },
    })).rejects.toMatchObject({ code: 75 })
    expect((await readFile(output, 'utf8')).trim().split('\n')).toEqual([
      '--exclusive', '--nonblock', '--conflict-exit-code', '75', '--no-fork',
      join(root, '.dsh-node.lock'), 'node', '/app/server/dist/src/runtime/node/main.js',
    ])
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('rejects a symlink lock without touching its target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'node-lock-link-'))
  try {
    const target = join(root, 'external')
    await writeFile(target, 'preserve')
    await symlink(target, join(root, '.dsh-node.lock'))
    await expect(exec('bash', [entrypoint, 'node-agent'], {
      env: { ...process.env, HOST_STORAGE_ROOT: root },
    })).rejects.toMatchObject({ code: 1 })
    expect(await readFile(target, 'utf8')).toBe('preserve')
  } finally { await rm(root, { recursive: true, force: true }) }
})
