import { open } from "node:fs/promises";

export async function writeDurableExclusive(
  path: string,
  value: string | Buffer,
  afterWrite?: () => Promise<void> | void,
): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(value, typeof value === "string" ? "utf8" : undefined);
    await afterWrite?.();
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function syncDirectory(path: string): Promise<void> {
  // Windows directory handles cannot be fsynced through node:fs; promotion
  // uses MoveFileExW with MOVEFILE_WRITE_THROUGH instead.
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
