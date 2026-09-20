import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { assertStorageRoot } from './storage-root.js'

it('accepts a private canonical pool and rejects writable, aliased and invalid roots', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'dsh-root-admission-')))
  try {
    const root = join(directory, 'pool')
    await mkdir(root, { mode: 0o700 })
    const uid = process.getuid!()
    await expect(assertStorageRoot(root, uid)).resolves.toBeUndefined()
    await expect(assertStorageRoot(root, uid + 1)).rejects.toThrow('owned by root')
    for (const mode of [0o770, 0o707, 0o777]) {
      await chmod(root, mode)
      await expect(assertStorageRoot(root, uid)).rejects.toThrow('not writable')
    }
    await chmod(root, 0o700)
    const alias = join(directory, 'alias')
    await symlink(root, alias)
    await expect(assertStorageRoot(alias, uid)).rejects.toThrow('symbolic links')
    await expect(assertStorageRoot(`${directory}/./pool`, uid)).rejects.toThrow('canonical')
    await expect(assertStorageRoot('/', uid)).rejects.toThrow('non-root')
    const file = join(directory, 'file')
    await writeFile(file, '')
    await expect(assertStorageRoot(file, uid)).rejects.toThrow('symbolic links')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
