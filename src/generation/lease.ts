import { AsyncLocalStorage } from "node:async_hooks";

import { withProjectLease } from "../project/lock.js";
import { validateProjectRoot } from "../project/paths.js";

type GenerationLeaseOwner = {
  active: boolean;
  canonicalRoot: string;
};

const activeGenerationLease = new AsyncLocalStorage<GenerationLeaseOwner>();

export async function withGenerationLease<T>(
  projectRoot: string,
  action: (canonicalRoot: string) => Promise<T>,
): Promise<T> {
  const canonicalRoot = await validateProjectRoot(projectRoot);
  const owner = activeGenerationLease.getStore();
  if (owner?.active && owner.canonicalRoot === canonicalRoot) return action(canonicalRoot);
  return withProjectLease(canonicalRoot, "generation", async (leasedRoot) => {
    const nextOwner: GenerationLeaseOwner = { active: true, canonicalRoot: leasedRoot };
    try {
      return await activeGenerationLease.run(nextOwner, () => action(leasedRoot));
    } finally {
      nextOwner.active = false;
    }
  });
}

export function assertGenerationLeaseHeld(canonicalRoot: string): void {
  const owner = activeGenerationLease.getStore();
  if (!owner?.active || owner.canonicalRoot !== canonicalRoot) {
    throw new Error("trusted generation recovery requires the project generation lease");
  }
}
