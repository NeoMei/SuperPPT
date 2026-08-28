import { AsyncLocalStorage } from "node:async_hooks";

import { withProjectLease } from "../project/lock.js";

const activeGenerationLease = new AsyncLocalStorage<string>();

export async function withGenerationLease<T>(
  projectRoot: string,
  action: (canonicalRoot: string) => Promise<T>,
): Promise<T> {
  const active = activeGenerationLease.getStore();
  if (active !== undefined && active === projectRoot) return action(active);
  return withProjectLease(projectRoot, "generation", async (canonicalRoot) =>
    activeGenerationLease.run(canonicalRoot, () => action(canonicalRoot))
  );
}

export function assertGenerationLeaseHeld(canonicalRoot: string): void {
  if (activeGenerationLease.getStore() !== canonicalRoot) {
    throw new Error("trusted generation recovery requires the project generation lease");
  }
}
