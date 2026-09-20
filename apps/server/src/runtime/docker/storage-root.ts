import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, normalize, parse } from 'node:path'

export async function assertStorageRoot(root: string, expectedUid = 0): Promise<void> {
  if (!isAbsolute(root) || normalize(root) !== root || root === parse(root).root) {
    throw new Error('Storage pool requires a canonical non-root absolute path')
  }
  const info = await lstat(root)
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) {
    throw new Error('Storage pool path must not contain symbolic links')
  }
  if (info.uid !== expectedUid || (info.mode & 0o022) !== 0) {
    throw new Error('Storage pool must be owned by root and not writable by group or other users')
  }
}
