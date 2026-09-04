import { readFile } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

async function isSuperPptRoot(directory: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as { name?: unknown };
    return manifest.name === "superppt";
  } catch {
    return false;
  }
}

export async function repositorySourcePath(relativePath: string): Promise<string> {
  let directory = dirname(fileURLToPath(import.meta.url));
  const filesystemRoot = parse(directory).root;
  while (true) {
    if (await isSuperPptRoot(directory)) return join(directory, relativePath);
    if (directory === filesystemRoot) throw new Error("SuperPPT repository root not found");
    directory = dirname(directory);
  }
}
