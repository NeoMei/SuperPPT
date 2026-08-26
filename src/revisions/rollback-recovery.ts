import { sha256Evidence } from "../project/evidence.js";
import { withProjectLease } from "../project/lock.js";
import { hasPendingRollbackTransaction } from "../project/rollback-guard.js";
import { ProjectManifestSchema, type ProjectManifest } from "../project/schemas.js";
import {
  abortProjectRollbackTransaction,
  readProjectForRollbackRecovery,
} from "../project/store.js";
import type { RevisionEvidenceOperations } from "./anchored-fs.js";
import {
  finalizeRollbackJournal,
  readRollbackJournal,
} from "./rollback-journal.js";
import { readProjectFileSet, writeProjectFileSet } from "./project-files.js";

export type RollbackRecoveryOptions = {
  operations?: RevisionEvidenceOperations;
};

export type RollbackRecoveryResult = false | {
  outcome: "before" | "after";
  targetRevisionId: string;
  rollbackRevisionId: string;
};

function manifestBytes(manifest: ProjectManifest): Buffer {
  return Buffer.from(`${JSON.stringify(ProjectManifestSchema.parse(manifest), null, 2)}\n`);
}

async function assertFileSet(root: string, expected: ReadonlyMap<string, Buffer | null>): Promise<void> {
  const actual = await readProjectFileSet(root, [...expected.keys()]);
  for (const [path, bytes] of expected) {
    const value = actual.get(path) ?? null;
    if (bytes === null ? value !== null : !value?.equals(bytes)) {
      throw new Error(`rollback recovery did not converge: ${path}`);
    }
  }
}

export async function recoverRollbackTransactionLocked(
  root: string,
  options: RollbackRecoveryOptions = {},
): Promise<RollbackRecoveryResult> {
  if (!await hasPendingRollbackTransaction(root)) return false;
  const evidence = await readRollbackJournal(root, options.operations);
  const current = await readProjectForRollbackRecovery(root);
  if (current.manifest.projectId !== evidence.journal.projectId) {
    throw new Error("rollback journal project identity is invalid");
  }
  let desired: ReadonlyMap<string, Buffer | null>;
  let outcome: "before" | "after";
  const marker = current.manifest.rollbackTransaction;
  if (
    !marker
    && current.baseIdentity === evidence.journal.baseManifestSha256
    && current.manifest.currentRevision.id === evidence.journal.baseRevisionId
  ) {
    await finalizeRollbackJournal(root, evidence.journal.transactionId, options.operations);
    return {
      outcome: "before",
      targetRevisionId: evidence.journal.targetRevisionId,
      rollbackRevisionId: evidence.journal.rollbackRevisionId,
    };
  } else if (marker) {
    const { rollbackTransaction: _marker, ...withoutMarker } = current.manifest;
    const baseIdentity = sha256Evidence(manifestBytes(ProjectManifestSchema.parse(withoutMarker)));
    if (
      baseIdentity !== evidence.journal.baseManifestSha256
      || current.manifest.currentRevision.id !== evidence.journal.baseRevisionId
      || marker.transactionId !== evidence.journal.transactionId
      || marker.baseRevisionId !== evidence.journal.baseRevisionId
      || marker.targetRevisionId !== evidence.journal.targetRevisionId
      || marker.rollbackRevisionId !== evidence.journal.rollbackRevisionId
      || marker.descriptorSha256 !== evidence.journal.transactionAnchorSha256
    ) throw new Error("rollback transaction descriptor anchor mismatch");
    desired = evidence.before;
    outcome = "before";
  } else if (
    current.baseIdentity === evidence.journal.rollbackManifestSha256
    && current.manifest.currentRevision.id === evidence.journal.rollbackRevisionId
    && current.manifest.currentRevision.rollbackTransactionDescriptorSha256
      === evidence.journal.transactionAnchorSha256
  ) {
    desired = evidence.after;
    outcome = "after";
  } else {
    throw new Error("rollback journal does not match the current manifest state");
  }
  await writeProjectFileSet(root, desired, options.operations);
  await assertFileSet(root, desired);
  if (outcome === "before") {
    await abortProjectRollbackTransaction(root, options.operations);
  }
  await finalizeRollbackJournal(root, evidence.journal.transactionId, options.operations);
  return {
    outcome,
    targetRevisionId: evidence.journal.targetRevisionId,
    rollbackRevisionId: evidence.journal.rollbackRevisionId,
  };
}

export async function recoverRollbackTransaction(
  root: string,
  options: RollbackRecoveryOptions = {},
): Promise<boolean> {
  const result = await withProjectLease(root, "revision-impact", (canonicalRoot) =>
    recoverRollbackTransactionLocked(canonicalRoot, options));
  return result !== false;
}
