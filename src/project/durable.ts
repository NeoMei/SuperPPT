import { open } from "node:fs/promises";

export async function writeDurableExclusive(
  path: string,
  value: string,
  afterWrite?: () => Promise<void> | void,
): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(value, "utf8");
    await afterWrite?.();
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
