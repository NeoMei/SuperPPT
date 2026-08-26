import { lstat, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  parse,
  relative,
  resolve,
} from "node:path";

export function isSameOrAncestor(candidate: string, child: string): boolean {
  const difference = relative(candidate, child);
  return difference === ""
    || (!difference.startsWith("..") && !isAbsolute(difference));
}

export async function canonicalPotential(path: string): Promise<string> {
  let cursor = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(cursor), ...missing);
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw new Error(`Unsafe project root: ${path}`, { cause: error });
      }
      const parent = dirname(cursor);
      if (parent === cursor) {
        throw new Error(`Unsafe project root: ${path}`, { cause: error });
      }
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

export async function validateProjectRoot(root: string): Promise<string> {
  if (!root.trim() || !isAbsolute(root)) {
    throw new Error(`Unsafe project root: ${root || "empty path"}`);
  }
  const canonical = await canonicalPotential(root);
  const cwd = await realpath(process.cwd());
  if (
    canonical === parse(canonical).root
    || isSameOrAncestor(canonical, cwd)
  ) {
    throw new Error(`Unsafe project root: ${root}`);
  }
  try {
    const info = await lstat(resolve(root));
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Unsafe project root: ${root}`);
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  return canonical;
}
