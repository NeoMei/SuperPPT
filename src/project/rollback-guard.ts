import { lstat } from "node:fs/promises";
import { join } from "node:path";

export const ACTIVE_ROLLBACK_TRANSACTION = "rollback-transaction";

export async function hasPendingRollbackTransaction(root: string): Promise<boolean> {
  try {
    await lstat(join(root, "revisions", ACTIVE_ROLLBACK_TRANSACTION));
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error("pending rollback transaction state is unsafe", { cause: error });
  }
}

export async function assertNoPendingRollbackTransaction(root: string): Promise<void> {
  if (await hasPendingRollbackTransaction(root)) {
    throw new Error("project has a pending rollback transaction; recovery is required");
  }
}

export async function requirePendingRollbackTransaction(root: string): Promise<void> {
  if (!await hasPendingRollbackTransaction(root)) {
    throw new Error("rollback manifest publication requires an active transaction");
  }
}
