import { constants } from 'node:fs';
import { copyFile, lstat, rename, unlink } from 'node:fs/promises';

// Output publication only. No native platform ABI or authorization machinery.
export async function promoteExclusive(source: string, target: string): Promise<void> {
  if ((await lstat(source)).isFile()) {
    await copyFile(source, target, constants.COPYFILE_EXCL);
    await unlink(source);
  } else {
    try { await lstat(target); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await rename(source, target);
      return;
    }
    throw Object.assign(new Error('Output already exists'), { code: 'EEXIST' });
  }
}
export const renameSafe = rename;
