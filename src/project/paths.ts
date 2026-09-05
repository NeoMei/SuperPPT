import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, parse, relative, resolve } from 'node:path';
export function isSameOrAncestor(candidate: string, child: string): boolean {
  const delta = relative(candidate, child);
  return delta === '' || (!delta.startsWith('..') && !isAbsolute(delta));
}
export async function canonicalPotential(path: string): Promise<string> {
  try { return await realpath(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(resolve(path));
    if (parent === resolve(path)) throw error;
    return resolve(await canonicalPotential(parent), basename(path));
  }
}
export async function validateProjectRoot(root: string): Promise<string> {
  if (!isAbsolute(root) || root === parse(root).root) throw new Error('Use an absolute task directory');
  return canonicalPotential(root);
}
