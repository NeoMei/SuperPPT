import { lstat, open, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

import { syncDirectory } from "../project/durable.js";
import { readProject } from "../project/store.js";

export type InputRequest =
  | { kind: "description" | "text"; value: string }
  | { kind: "markdown"; path: string };

async function writeBytesExclusive(path: string, value: Buffer): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function normalizeInput(
  projectRoot: string,
  request: InputRequest,
): Promise<string> {
  await readProject(projectRoot);
  const root = await realpath(projectRoot);
  const sourceDirectory = join(root, "source");
  const sourceDirectoryInfo = await lstat(sourceDirectory);
  if (sourceDirectoryInfo.isSymbolicLink() || !sourceDirectoryInfo.isDirectory()) {
    throw new Error("project directory is not owned by SuperPPT");
  }

  let content: Buffer;
  if (request.kind === "markdown") {
    const info = await lstat(request.path);
    if (
      info.isSymbolicLink()
      || !info.isFile()
      || !request.path.toLowerCase().endsWith(".md")
    ) {
      throw new Error("Markdown input must be a regular .md file");
    }
    content = await readFile(request.path);
  } else {
    content = Buffer.from(request.value, "utf8");
  }
  if (!content.toString("utf8").trim()) {
    throw new Error("input content must not be empty");
  }

  const destination = join(sourceDirectory, "original.md");
  await writeBytesExclusive(destination, content);
  await syncDirectory(sourceDirectory);
  return destination;
}
