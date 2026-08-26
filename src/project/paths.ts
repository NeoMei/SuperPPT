import { lstat, realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  parse,
  relative,
  resolve,
  sep,
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

async function assertNoSymlinkComponents(path: string): Promise<void> {
  const absolute = resolve(path);
  const parsed = parse(absolute);
  const components = relative(parsed.root, absolute).split(sep).filter(Boolean);
  let cursor = parsed.root;
  for (const component of components) {
    cursor = resolve(cursor, component);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`Unsafe project root: ${path}`);
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

export async function validateProjectRoot(root: string): Promise<string> {
  if (!root.trim() || !isAbsolute(root)) {
    throw new Error(`Unsafe project root: ${root || "empty path"}`);
  }
  await assertNoSymlinkComponents(root);
  const canonical = await canonicalPotential(root);
  const cwd = await realpath(process.cwd());
  if (
    canonical === parse(canonical).root
    || isSameOrAncestor(canonical, cwd)
  ) {
    throw new Error(`Unsafe project root: ${root}`);
  }
  return canonical;
}
