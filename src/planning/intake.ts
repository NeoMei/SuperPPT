import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { syncDirectory } from "../project/durable.js";
import { readAnchoredRegularFile } from "../project/safe-file.js";
import { readProject } from "../project/store.js";

export type InputRequest =
  | { kind: "description" | "text"; value: string }
  | { kind: "markdown"; path: string };

const InputRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.enum(["description", "text"]), value: z.string() }).strict(),
  z.object({ kind: z.literal("markdown"), path: z.string().min(1) }).strict(),
]);

export type NormalizeInputOperations = {
  afterSourceOpened?: () => Promise<void> | void;
};

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
  operations: NormalizeInputOperations = {},
): Promise<string> {
  const parsed = InputRequestSchema.safeParse(request);
  if (!parsed.success) throw new Error("invalid input request", { cause: parsed.error });
  request = parsed.data;
  await readProject(projectRoot);
  const root = await realpath(projectRoot);
  const sourceDirectory = join(root, "source");
  const sourceDirectoryInfo = await lstat(sourceDirectory);
  if (sourceDirectoryInfo.isSymbolicLink() || !sourceDirectoryInfo.isDirectory()) {
    throw new Error("project directory is not owned by SuperPPT");
  }

  let content: Buffer;
  if (request.kind === "markdown") {
    if (!request.path.toLowerCase().endsWith(".md")) {
      throw new Error("Markdown input must be a regular .md file");
    }
    try {
      content = await readAnchoredRegularFile(request.path, {
        label: "Markdown input",
        maxBytes: 16 * 1024 * 1024,
        operations: { afterOpen: operations.afterSourceOpened },
      });
    } catch (error: unknown) {
      if (operations.afterSourceOpened) throw new Error("Markdown input changed while reading", { cause: error });
      throw new Error("Markdown input must be a regular .md file", { cause: error });
    }
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
