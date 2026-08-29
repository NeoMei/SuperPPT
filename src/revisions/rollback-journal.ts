import { randomUUID } from "node:crypto";
import { z } from "zod";

import { sha256Evidence } from "../project/evidence.js";
import {
  ACTIVE_ROLLBACK_TRANSACTION,
  hasPendingRollbackTransaction,
} from "../project/rollback-guard.js";
import { ProjectManifestSchema, type ProjectManifest } from "../project/schemas.js";
import {
  type AnchoredDirectory,
  type RevisionEvidenceOperations,
  withAnchoredRevisions,
} from "./anchored-fs.js";
import { readRevisionSnapshot } from "./snapshot.js";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const BlobSchema = z.object({
  file: z.string().regex(/^(before|after)-\d{4}\.bin$/),
  sha256: HashSchema,
  size: z.number().int().nonnegative(),
}).strict();
const FileEntrySchema = z.object({
  path: z.string().min(1),
  before: BlobSchema.nullable(),
  after: BlobSchema,
}).strict();
const JournalBaseSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("rollback-transaction"),
  transactionId: z.string().uuid(),
  projectId: z.string().uuid(),
  journalPath: z.literal("revisions/rollback-transaction"),
  baseRevisionId: z.string().uuid(),
  baseRevisionNumber: z.number().int().positive(),
  baseManifestSha256: HashSchema,
  targetRevisionId: z.string().uuid(),
  rollbackRevisionId: z.string().uuid(),
  transactionAnchorSha256: HashSchema,
  rollbackManifestSha256: HashSchema,
  rollbackManifestSize: z.number().int().nonnegative(),
  files: z.array(FileEntrySchema),
  createdAt: z.string().datetime(),
}).strict();

export const RollbackJournalSchema = JournalBaseSchema.extend({
  descriptorSha256: HashSchema,
}).strict();

export type RollbackJournal = z.infer<typeof RollbackJournalSchema>;

type ReadJournal = {
  journal: RollbackJournal;
  rollbackManifest: ProjectManifest;
  before: Map<string, Buffer | null>;
  after: Map<string, Buffer>;
};

type RollbackManifestFactory = (transactionAnchorSha256: string) => ProjectManifest;

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function safeProjectPath(path: string): boolean {
  const parts = path.split("/");
  return parts.length > 0 && parts.every((part) =>
    Boolean(part) && part !== "." && part !== ".." && !part.includes("\\")
  );
}

function blobDescriptor(file: string, bytes: Buffer): z.infer<typeof BlobSchema> {
  return BlobSchema.parse({ file, sha256: sha256Evidence(bytes), size: bytes.length });
}

function addIntegrity(base: z.infer<typeof JournalBaseSchema>): RollbackJournal {
  return RollbackJournalSchema.parse({
    ...base,
    descriptorSha256: sha256Evidence(JSON.stringify(base)),
  });
}

function transactionAnchor(base: Omit<z.infer<typeof JournalBaseSchema>,
  "transactionAnchorSha256" | "rollbackManifestSha256" | "rollbackManifestSize"
>): string {
  return sha256Evidence(JSON.stringify(base));
}

function readBlob(
  directory: AnchoredDirectory,
  descriptor: z.infer<typeof BlobSchema>,
): Buffer {
  const bytes = directory.read(descriptor.file);
  if (
    !bytes
    || bytes.length !== descriptor.size
    || sha256Evidence(bytes) !== descriptor.sha256
  ) throw new Error(`rollback journal staged blob is invalid: ${descriptor.file}`);
  return bytes;
}

function readJournalDirectory(directory: AnchoredDirectory): ReadJournal {
  const firstTree = directory.listRegularFiles();
  const journalBytes = directory.read("journal.json");
  if (!journalBytes) throw new Error("rollback journal descriptor is invalid");
  let journal: RollbackJournal;
  try {
    journal = RollbackJournalSchema.parse(JSON.parse(journalBytes.toString("utf8")));
  } catch (error: unknown) {
    throw new Error("rollback journal descriptor is invalid", { cause: error });
  }
  const { descriptorSha256, ...base } = journal;
  if (descriptorSha256 !== sha256Evidence(JSON.stringify(base))) {
    throw new Error("rollback journal descriptor integrity is invalid");
  }
  const {
    transactionAnchorSha256,
    rollbackManifestSha256: _rollbackManifestSha256,
    rollbackManifestSize: _rollbackManifestSize,
    ...anchorBase
  } = base;
  if (transactionAnchorSha256 !== transactionAnchor(anchorBase)) {
    throw new Error("rollback journal transaction anchor integrity is invalid");
  }
  const paths = journal.files.map((entry) => entry.path);
  if (
    paths.some((path) => !safeProjectPath(path))
    || new Set(paths).size !== paths.length
    || !sameList(paths, [...paths].sort())
  ) throw new Error("rollback journal file identity is invalid");
  const expectedFiles = [
    "journal.json",
    "rollback-superppt.json",
    ...journal.files.flatMap((entry) => [entry.before?.file, entry.after.file])
      .filter((file): file is string => file !== undefined),
  ].sort();
  if (new Set(expectedFiles).size !== expectedFiles.length || !sameList(firstTree, expectedFiles)) {
    throw new Error("rollback journal tree is invalid");
  }
  const rollbackBytes = directory.read("rollback-superppt.json");
  if (
    !rollbackBytes
    || rollbackBytes.length !== journal.rollbackManifestSize
    || sha256Evidence(rollbackBytes) !== journal.rollbackManifestSha256
  ) throw new Error("rollback journal planned manifest is invalid");
  const rollbackManifest = ProjectManifestSchema.parse(JSON.parse(rollbackBytes.toString("utf8")));
  if (
    rollbackManifest.projectId !== journal.projectId
    || rollbackManifest.currentRevision.id !== journal.rollbackRevisionId
    || rollbackManifest.currentRevision.parentId !== journal.baseRevisionId
    || rollbackManifest.currentRevision.number !== journal.baseRevisionNumber + 1
    || rollbackManifest.revisions.at(-1)?.id !== journal.rollbackRevisionId
    || rollbackManifest.currentRevision.rollbackTransactionDescriptorSha256 !== journal.transactionAnchorSha256
    || rollbackManifest.rollbackTransaction
    || !rollbackManifest.revisions.some((revision) => revision.id === journal.targetRevisionId)
  ) throw new Error("rollback journal planned manifest identity is invalid");

  const before = new Map<string, Buffer | null>();
  const after = new Map<string, Buffer>();
  for (const entry of journal.files) {
    before.set(entry.path, entry.before ? readBlob(directory, entry.before) : null);
    after.set(entry.path, readBlob(directory, entry.after));
  }
  const journalAgain = directory.read("journal.json");
  const rollbackAgain = directory.read("rollback-superppt.json");
  if (
    !journalAgain?.equals(journalBytes)
    || !rollbackAgain?.equals(rollbackBytes)
    || !sameList(directory.listRegularFiles(), expectedFiles)
  ) throw new Error("rollback journal changed while authenticating");
  return { journal, rollbackManifest, before, after };
}

async function assertAuthenticatedRollbackTarget(
  root: string,
  evidence: ReadJournal,
  operations?: RevisionEvidenceOperations,
): Promise<void> {
  let target: Awaited<ReturnType<typeof readRevisionSnapshot>>;
  try {
    target = await readRevisionSnapshot(root, evidence.journal.targetRevisionId, operations);
  } catch (error: unknown) {
    throw new Error("rollback journal target snapshot is missing, unsafe, or unauthentic", { cause: error });
  }
  const rollback = evidence.rollbackManifest;
  const targetIndex = rollback.revisions.findIndex(({ id }) => id === evidence.journal.targetRevisionId);
  const baseIndex = rollback.revisions.findIndex(({ id }) => id === evidence.journal.baseRevisionId);
  const targetChild = rollback.revisions[targetIndex + 1];
  const expected = ProjectManifestSchema.parse({
    ...target.manifest,
    currentRevision: rollback.currentRevision,
    revisions: rollback.revisions,
    gates: rollback.gates,
  });
  if (
    target.descriptor.projectId !== evidence.journal.projectId
    || target.manifest.projectId !== evidence.journal.projectId
    || targetIndex < 0
    || baseIndex < targetIndex
    || baseIndex !== rollback.revisions.length - 2
    || !sameJson(target.manifest.revisions, rollback.revisions.slice(0, targetIndex + 1))
    || !targetChild
    || targetChild.parentId !== evidence.journal.targetRevisionId
    || targetChild.parentSnapshotDescriptorSha256 !== target.descriptor.descriptorSha256
    || !sameJson(rollback, expected)
  ) throw new Error("rollback journal target snapshot or restored generation history is invalid");
}

export async function publishRollbackJournal(options: {
  root: string;
  current: ProjectManifest;
  baseManifestSha256: string;
  targetRevisionId: string;
  rollbackRevisionId: string;
  rollbackManifest: RollbackManifestFactory;
  before: ReadonlyMap<string, Buffer | null>;
  after: ReadonlyMap<string, Buffer>;
  operations?: RevisionEvidenceOperations;
}): Promise<{ journal: RollbackJournal; rollbackManifest: ProjectManifest }> {
  if (await hasPendingRollbackTransaction(options.root)) {
    throw new Error("a rollback transaction is already pending");
  }
  const entries = [...options.after.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, afterBytes], index) => {
      const suffix = index.toString().padStart(4, "0");
      const beforeBytes = options.before.get(path) ?? null;
      return FileEntrySchema.parse({
        path,
        before: beforeBytes ? blobDescriptor(`before-${suffix}.bin`, beforeBytes) : null,
        after: blobDescriptor(`after-${suffix}.bin`, afterBytes),
      });
    });
  const beforePaths = [...options.before.keys()].sort();
  const afterPaths = entries.map((entry) => entry.path);
  if (
    !sameList(beforePaths, afterPaths)
    || entries.some((entry) => !safeProjectPath(entry.path))
  ) {
    throw new Error("rollback journal before and after file sets must match exactly");
  }
  const transactionId = randomUUID();
  const createdAt = new Date().toISOString();
  const anchorBase = {
    schemaVersion: 1,
    kind: "rollback-transaction",
    transactionId,
    projectId: options.current.projectId,
    journalPath: `revisions/${ACTIVE_ROLLBACK_TRANSACTION}`,
    baseRevisionId: options.current.currentRevision.id,
    baseRevisionNumber: options.current.currentRevision.number,
    baseManifestSha256: options.baseManifestSha256,
    targetRevisionId: options.targetRevisionId,
    rollbackRevisionId: options.rollbackRevisionId,
    files: entries,
    createdAt,
  } as const;
  const transactionAnchorSha256 = transactionAnchor(anchorBase);
  const rollbackManifest = ProjectManifestSchema.parse(options.rollbackManifest(transactionAnchorSha256));
  const rollbackBytes = Buffer.from(`${JSON.stringify(rollbackManifest, null, 2)}\n`);
  const base = JournalBaseSchema.parse({
    ...anchorBase,
    transactionAnchorSha256,
    rollbackManifestSha256: sha256Evidence(rollbackBytes),
    rollbackManifestSize: rollbackBytes.length,
  });
  const journal = addIntegrity(base);
  await withAnchoredRevisions(options.root, options.operations, (revisions) => {
    const stagingName = `.rollback-${journal.transactionId}.staging`;
    const staging = revisions.child(stagingName);
    try {
      for (const entry of journal.files) {
        const beforeBytes = options.before.get(entry.path) ?? null;
        if (entry.before && beforeBytes) staging.writeExclusive(entry.before.file, beforeBytes);
        staging.writeExclusive(entry.after.file, options.after.get(entry.path)!);
      }
      staging.writeExclusive("rollback-superppt.json", rollbackBytes);
      staging.writeExclusive("journal.json", `${JSON.stringify(journal, null, 2)}\n`);
      const expected = [
        "journal.json",
        "rollback-superppt.json",
        ...journal.files.flatMap((entry) => [entry.before?.file, entry.after.file])
          .filter((file): file is string => file !== undefined),
      ].sort();
      if (!sameList(staging.listRegularFiles(), expected)) {
        throw new Error("rollback journal staging tree is invalid");
      }
    } finally {
      staging.close();
    }
    revisions.promoteChildExclusive(stagingName, ACTIVE_ROLLBACK_TRANSACTION);
  });
  return { journal, rollbackManifest };
}

export async function readRollbackJournal(
  root: string,
  operations?: RevisionEvidenceOperations,
): Promise<ReadJournal> {
  try {
    const evidence = await withAnchoredRevisions(root, operations, (revisions) => {
      const active = revisions.child(ACTIVE_ROLLBACK_TRANSACTION, false);
      try {
        return readJournalDirectory(active);
      } finally {
        active.close();
      }
    });
    await assertAuthenticatedRollbackTarget(root, evidence, operations);
    return evidence;
  } catch (error: unknown) {
    const message = (error as Error).message;
    if (message.startsWith("rollback journal")) throw error;
    throw new Error("rollback journal is unsafe", { cause: error });
  }
}

export async function finalizeRollbackJournal(
  root: string,
  transactionId: string,
  operations?: RevisionEvidenceOperations,
): Promise<void> {
  await withAnchoredRevisions(root, operations, (revisions) => {
    revisions.promoteChildExclusive(
      ACTIVE_ROLLBACK_TRANSACTION,
      `.rollback-completed-${transactionId}`,
    );
  });
}
