import { open } from 'node:fs/promises';
import { sep } from 'node:path';
import { taskPath } from './task-store.js';

export type SafeReadOperations = { maxBytes?: number; afterOpen?: (path: string) => Promise<void> | void };
export const DEFAULT_SAFE_READ_MAX_BYTES = 256 * 1024 * 1024;

// Read one bounded file snapshot and detect ordinary concurrent saves.
export async function readRegularFileNoFollow(path: string, operations: SafeReadOperations = {}): Promise<Buffer> {
  const max = operations.maxBytes ?? DEFAULT_SAFE_READ_MAX_BYTES;
  if (!Number.isSafeInteger(max) || max <= 0) throw new Error('Invalid size limit');
  const file = await open(path, 'r');
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > max) throw new Error('Input must be a bounded regular file');
    await operations.afterOpen?.(path);
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    const after = await file.stat();
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('File changed while reading; save and close before retrying');
    return bytes;
  } finally { await file.close(); }
}
export const readRegularFileSnapshotNoFollow = readRegularFileNoFollow;
export const localProjectPath = (path: string) => path.split('/').join(sep);
export async function readOwnedRegularFile(root: string, path: string, operations: SafeReadOperations = {}): Promise<Buffer> {
  return readRegularFileNoFollow(await taskPath(root, path), operations);
}
