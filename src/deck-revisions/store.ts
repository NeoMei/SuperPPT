import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

import { syncDirectory, writeDurableExclusive } from "../project/durable.js";
import { withProjectLease } from "../project/lock.js";
import { readRegularFileNoFollow } from "../project/safe-file.js";
import { readProject, updateProject } from "../project/store.js";
import { inspectLocalPptx } from "./inspect.js";
import { reconcileSlideTopology } from "./topology.js";
import {
  CurrentDeckPointerSchema,
  DeckAdoptionEvidenceSchema,
  DeckEditSessionSchema,
  LocalDeckRevisionSchema,
  SlideTopologySchema,
  type CurrentDeckPointer,
  type DeckEditSession,
  type ResolvedCurrentDeckPointer,
  type ResolvedDeckEditSession,
  type ResolvedLocalDeckRevision,
  type SlideTopology,
} from "./schemas.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const UuidSchema = z.string().uuid();
const CreateDeckCandidateOptionsSchema = z.object({
  sourceRevisionId: UuidSchema,
  reason: z.enum(["manual-edit", "agent-edit", "slide-regeneration"]),
  changedSlideIds: z.array(UuidSchema),
  editableSlideIds: z.array(UuidSchema),
  targetSlideId: UuidSchema.optional(),
  mode: z.enum(["manual", "agent"]).optional(),
}).strict();
const AdoptionJournalSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string().uuid(),
  reason: z.enum(["manual-edit", "agent-edit", "slide-regeneration"]),
  changedSlideIds: z.array(z.string().uuid()),
  editableSlideIds: z.array(z.string().uuid()),
  adoption: z.object({
    adoptionId: z.string().uuid(),
    adoptedAt: z.string().datetime(),
    userSignal: z.literal("saved-and-closed").nullable(),
    confirmedSha256: Sha256Schema.nullable(),
  }).strict().nullable(),
  entries: z.array(z.object({ phase: z.string().min(1), at: z.string().datetime() }).strict()),
}).strict();
type AdoptionJournal = z.infer<typeof AdoptionJournalSchema>;

export type DeckAdoptionCheckpoint = "revision-written" | "evidence-written" | "pointer-written" | "session-adopted";
export type DeckAdoptionOperations = {
  checkpoint?: (phase: DeckAdoptionCheckpoint) => Promise<void> | void;
};

type CreateDeckCandidateOptions = {
  sourceRevisionId: string;
  reason: "manual-edit" | "agent-edit" | "slide-regeneration";
  changedSlideIds: string[];
  editableSlideIds: string[];
  targetSlideId?: string;
  mode?: "manual" | "agent";
};

type AdoptDeckCandidateOptions = {
  sessionId: string;
  mode: "manual" | "agent";
  userSignal?: "saved-and-closed";
  confirmedSha256?: string;
  operations?: DeckAdoptionOperations;
};

type BootstrapInitialDeckRevisionOptions = {
  revisionId: string;
  projectRevisionId: string;
  sourceAbsolutePath: string;
  slideTopology: SlideTopology;
  changedSlideIds: string[];
};

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`unsafe deck metadata directory: ${path}`);
}

async function ensureDeckRoots(root: string): Promise<void> {
  await ensureDirectory(join(root, "output"));
  await ensureDirectory(join(root, "output", "deck-revisions"));
  await ensureDirectory(join(root, "output", "deck-edit-sessions"));
}

async function replaceJson(path: string, value: unknown): Promise<void> {
  const staging = join(dirname(path), `.${randomUUID()}.staging.json`);
  await writeDurableExclusive(staging, json(value));
  await rename(staging, path);
  await syncDirectory(dirname(path));
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse((await readRegularFileNoFollow(path)).toString("utf8"));
}

function revisionPath(root: string, revisionId: string): string {
  return join(root, "output", "deck-revisions", revisionId);
}

function revisionRelativePath(revisionId: string): string {
  return `output/deck-revisions/${UuidSchema.parse(revisionId)}/deck.pptx`;
}

function sessionPath(root: string, sessionId: string): string {
  return join(root, "output", "deck-edit-sessions", sessionId);
}

async function writeExclusiveJson(path: string, value: unknown): Promise<void> {
  try {
    await writeDurableExclusive(path, json(value));
    await syncDirectory(dirname(path));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readJson(path);
    if (JSON.stringify(existing) !== JSON.stringify(value)) throw new Error("immutable deck metadata already exists with different bytes");
  }
}

async function readSession(root: string, sessionId: string): Promise<DeckEditSession> {
  const validSessionId = UuidSchema.parse(sessionId);
  return DeckEditSessionSchema.parse(await readJson(join(sessionPath(root, validSessionId), "session.json")));
}

async function readJournal(root: string, sessionId: string): Promise<AdoptionJournal> {
  const validSessionId = UuidSchema.parse(sessionId);
  return AdoptionJournalSchema.parse(await readJson(join(sessionPath(root, validSessionId), "journal.json")));
}

async function writeSession(root: string, value: DeckEditSession): Promise<void> {
  await replaceJson(join(sessionPath(root, value.sessionId), "session.json"), DeckEditSessionSchema.parse(value));
}

async function updateJournal(
  root: string,
  sessionId: string,
  updater: (journal: AdoptionJournal) => AdoptionJournal,
): Promise<AdoptionJournal> {
  const next = AdoptionJournalSchema.parse(updater(await readJournal(root, sessionId)));
  await replaceJson(join(sessionPath(root, sessionId), "journal.json"), next);
  return next;
}

async function appendJournal(root: string, sessionId: string, phase: string): Promise<AdoptionJournal> {
  return updateJournal(root, sessionId, (journal) => ({
    ...journal,
    entries: [...journal.entries, { phase, at: new Date().toISOString() }],
  }));
}

export async function readLocalDeckRevision(root: string, revisionId: string): Promise<ResolvedLocalDeckRevision> {
  const validRevisionId = UuidSchema.parse(revisionId);
  const manifest = await readProject(root);
  const record = LocalDeckRevisionSchema.parse(await readJson(join(revisionPath(root, validRevisionId), "revision.json")));
  if (record.revisionId !== validRevisionId || record.projectId !== manifest.projectId) {
    throw new Error("deck revision identity does not match the owned project");
  }
  const canonicalRelativePath = revisionRelativePath(validRevisionId);
  if (record.relativePath !== canonicalRelativePath) throw new Error("deck revision path does not match its identity");
  const absolutePath = join(root, ...canonicalRelativePath.split("/"));
  const inspected = await inspectLocalPptx(absolutePath);
  if (inspected.sha256 !== record.sha256) throw new Error("immutable deck revision bytes changed");
  return { ...record, absolutePath };
}

async function readCurrentDeckPointerUnlocked(root: string): Promise<ResolvedCurrentDeckPointer> {
  const pointer = CurrentDeckPointerSchema.parse(await readJson(join(root, "output", "current.json")));
  const revision = await readLocalDeckRevision(root, pointer.revisionId);
  if (pointer.relativePath !== revision.relativePath || pointer.sha256 !== revision.sha256) {
    throw new Error("current deck pointer does not bind its immutable revision");
  }
  return { ...pointer, absolutePath: revision.absolutePath };
}

export async function readCurrentDeckPointer(root: string): Promise<ResolvedCurrentDeckPointer> {
  return readCurrentDeckPointerUnlocked(root);
}

export async function bootstrapInitialDeckRevision(
  root: string,
  options: BootstrapInitialDeckRevisionOptions,
): Promise<ResolvedCurrentDeckPointer> {
  const revisionId = UuidSchema.parse(options.revisionId);
  const projectRevisionId = UuidSchema.parse(options.projectRevisionId);
  const slideTopology = SlideTopologySchema.parse(options.slideTopology);
  const changedSlideIds = z.array(UuidSchema).parse(options.changedSlideIds);
  return withProjectLease(root, "deck-revisions", async (canonicalRoot) => {
    await ensureDeckRoots(canonicalRoot);
    const manifest = await readProject(canonicalRoot);
    if (manifest.currentDeck !== null) return readCurrentDeckPointerUnlocked(canonicalRoot);
    if (manifest.currentRevision.id !== projectRevisionId) throw new Error("initial deck revision does not bind the current project revision");
    const source = await inspectLocalPptx(options.sourceAbsolutePath);
    if (source.projectRoot !== canonicalRoot) throw new Error("initial deck source escaped its owned project");
    if (
      slideTopology.entries.length !== source.slides.length
      || slideTopology.entries.some((entry, position) => {
        const slide = source.slides[position];
        return !slide
          || entry.position !== position
          || entry.slidePart !== slide.slidePart
          || entry.presentationSlideId !== slide.presentationSlideId
          || entry.creationId !== slide.creationId;
      })
    ) throw new Error("initial deck topology does not bind the source PPTX");
    const directory = revisionPath(canonicalRoot, revisionId);
    await mkdir(directory, { mode: 0o700 });
    const relativePath = revisionRelativePath(revisionId);
    const absolutePath = join(canonicalRoot, ...relativePath.split("/"));
    await writeDurableExclusive(absolutePath, await readRegularFileNoFollow(source.absolutePath));
    await syncDirectory(directory);
    const copied = await inspectLocalPptx(absolutePath);
    if (copied.sha256 !== source.sha256) throw new Error("initial immutable revision copy changed bytes");
    const createdAt = new Date().toISOString();
    const revision = LocalDeckRevisionSchema.parse({
      schemaVersion: 1,
      revisionId,
      parentRevisionId: null,
      projectId: manifest.projectId,
      projectRevisionId,
      reason: "initial",
      relativePath,
      sha256: copied.sha256,
      slideTopology,
      editableSlideIds: [],
      changedSlideIds,
      createdAt,
    });
    await writeExclusiveJson(join(directory, "revision.json"), revision);
    const pointer = await writeCurrentPointerOnly(canonicalRoot, {
      schemaVersion: 1,
      revisionId,
      relativePath,
      sha256: copied.sha256,
      updatedAt: createdAt,
    });
    await updateProject(canonicalRoot, (project) => {
      if (project.currentDeck !== null) throw new Error("initial deck pointer was concurrently created");
      return {
        ...project,
        currentDeck: CurrentDeckPointerSchema.parse({
          schemaVersion: pointer.schemaVersion,
          revisionId: pointer.revisionId,
          relativePath: pointer.relativePath,
          sha256: pointer.sha256,
          updatedAt: pointer.updatedAt,
        }),
      };
    });
    return pointer;
  });
}

async function writeCurrentPointerOnly(root: string, value: CurrentDeckPointer): Promise<ResolvedCurrentDeckPointer> {
  const pointer = CurrentDeckPointerSchema.parse(value);
  await replaceJson(join(root, "output", "current.json"), pointer);
  return { ...pointer, absolutePath: join(root, ...pointer.relativePath.split("/")) };
}

export async function createDeckCandidate(
  root: string,
  options: CreateDeckCandidateOptions,
): Promise<ResolvedDeckEditSession> {
  const validOptions = CreateDeckCandidateOptionsSchema.parse(options);
  return withProjectLease(root, "deck-revisions", async (canonicalRoot) => {
    await ensureDeckRoots(canonicalRoot);
    const manifest = await readProject(canonicalRoot);
    if (manifest.activeDeckEditSessionId !== null) throw new Error("another deck edit session is active");
    const current = await readCurrentDeckPointerUnlocked(canonicalRoot);
    if (current.revisionId !== validOptions.sourceRevisionId) throw new Error("deck candidate source is not current");
    const parent = await readLocalDeckRevision(canonicalRoot, validOptions.sourceRevisionId);
    const candidateRevisionId = randomUUID();
    const sessionId = randomUUID();
    const candidateRelativePath = revisionRelativePath(candidateRevisionId);
    const candidateRoot = revisionPath(canonicalRoot, candidateRevisionId);
    const editSessionRoot = sessionPath(canonicalRoot, sessionId);
    await mkdir(candidateRoot, { mode: 0o700 });
    await mkdir(editSessionRoot, { mode: 0o700 });
    const source = await readRegularFileNoFollow(parent.absolutePath);
    await writeDurableExclusive(join(candidateRoot, "deck.pptx"), source);
    await syncDirectory(candidateRoot);
    const authenticatedCandidate = await inspectLocalPptx(join(candidateRoot, "deck.pptx"));
    if (authenticatedCandidate.sha256 !== parent.sha256) {
      throw new Error("deck candidate copy does not match its source revision");
    }
    const mode = validOptions.mode ?? (validOptions.reason === "manual-edit" ? "manual" : "agent");
    const targetSlideId = validOptions.targetSlideId ?? validOptions.changedSlideIds[0];
    if (!targetSlideId) throw new Error("deck candidate requires one target slide identity");
    const now = new Date().toISOString();
    const session = DeckEditSessionSchema.parse({
      schemaVersion: 1,
      sessionId,
      candidateRevisionId,
      parentRevisionId: parent.revisionId,
      mode,
      targetSlideId,
      state: "prepared",
      candidateRelativePath,
      preparedSha256: parent.sha256,
      presentedSha256: null,
      createdAt: now,
      completedAt: null,
    });
    const journal = AdoptionJournalSchema.parse({
      schemaVersion: 1,
      sessionId,
      reason: validOptions.reason,
      changedSlideIds: validOptions.changedSlideIds,
      editableSlideIds: validOptions.editableSlideIds,
      adoption: null,
      entries: [{ phase: "prepared", at: now }],
    });
    await writeDurableExclusive(join(editSessionRoot, "session.json"), json(session));
    await writeDurableExclusive(join(editSessionRoot, "journal.json"), json(journal));
    await syncDirectory(editSessionRoot);
    await updateProject(canonicalRoot, (project) => ({ ...project, activeDeckEditSessionId: sessionId }));
    return { ...session, absolutePath: join(canonicalRoot, ...candidateRelativePath.split("/")) };
  });
}

async function finalizeAdoption(
  root: string,
  session: DeckEditSession,
  revision: ResolvedLocalDeckRevision | ReturnType<typeof LocalDeckRevisionSchema.parse>,
  journal: AdoptionJournal,
  operations: DeckAdoptionOperations = {},
): Promise<ResolvedCurrentDeckPointer> {
  const { absolutePath: _absolutePath, ...persistedRevision } = revision as ResolvedLocalDeckRevision;
  const revisionRecord = LocalDeckRevisionSchema.parse(persistedRevision);
  if (!journal.entries.some((entry) => entry.phase === "revision-writing")) {
    journal = await appendJournal(root, session.sessionId, "revision-writing");
  }
  await writeExclusiveJson(join(revisionPath(root, revisionRecord.revisionId), "revision.json"), revisionRecord);
  if (!journal.entries.some((entry) => entry.phase === "revision-written")) {
    journal = await appendJournal(root, session.sessionId, "revision-written");
  }
  await operations.checkpoint?.("revision-written");
  const adoption = journal.adoption;
  if (!adoption) throw new Error("deck adoption journal lacks validated confirmation");
  const evidence = DeckAdoptionEvidenceSchema.parse({
    schemaVersion: 1,
    adoptionId: adoption.adoptionId,
    mode: session.mode,
    candidateRevisionId: session.candidateRevisionId,
    previousRevisionId: session.parentRevisionId,
    adoptedSha256: revisionRecord.sha256,
    slideTopologySha256: revisionRecord.slideTopology.sha256,
    userSignal: adoption.userSignal,
    confirmedSha256: adoption.confirmedSha256,
    adoptedAt: adoption.adoptedAt,
  });
  if (!journal.entries.some((entry) => entry.phase === "evidence-writing")) {
    journal = await appendJournal(root, session.sessionId, "evidence-writing");
  }
  await writeExclusiveJson(join(revisionPath(root, revisionRecord.revisionId), "adoption.json"), evidence);
  if (!journal.entries.some((entry) => entry.phase === "evidence-written")) {
    journal = await appendJournal(root, session.sessionId, "evidence-written");
  }
  await operations.checkpoint?.("evidence-written");
  if (!journal.entries.some((entry) => entry.phase === "pointer-writing")) {
    journal = await appendJournal(root, session.sessionId, "pointer-writing");
  }
  const pointer = await writeCurrentPointerOnly(root, {
    schemaVersion: 1,
    revisionId: revisionRecord.revisionId,
    relativePath: revisionRecord.relativePath,
    sha256: revisionRecord.sha256,
    updatedAt: new Date().toISOString(),
  });
  if (!journal.entries.some((entry) => entry.phase === "pointer-written")) {
    await appendJournal(root, session.sessionId, "pointer-written");
  }
  await operations.checkpoint?.("pointer-written");
  await writeSession(root, {
    ...session,
    state: "adopted",
    presentedSha256: revisionRecord.sha256,
    completedAt: new Date().toISOString(),
  });
  await operations.checkpoint?.("session-adopted");
  const currentDeck = CurrentDeckPointerSchema.parse({
    schemaVersion: pointer.schemaVersion,
    revisionId: pointer.revisionId,
    relativePath: pointer.relativePath,
    sha256: pointer.sha256,
    updatedAt: pointer.updatedAt,
  });
  await updateProject(root, (project) => ({
    ...project,
    currentDeck,
    activeDeckEditSessionId: project.activeDeckEditSessionId === session.sessionId
      ? null
      : project.activeDeckEditSessionId,
  }));
  return pointer;
}

export async function adoptDeckCandidate(
  root: string,
  options: AdoptDeckCandidateOptions,
): Promise<ResolvedCurrentDeckPointer> {
  const validSessionId = UuidSchema.parse(options.sessionId);
  return withProjectLease(root, "deck-revisions", async (canonicalRoot) => {
    const session = await readSession(canonicalRoot, validSessionId);
    if (session.mode !== options.mode) throw new Error("deck adoption mode does not match its session");
    if (session.state === "adopted") return readCurrentDeckPointerUnlocked(canonicalRoot);
    const current = await readCurrentDeckPointerUnlocked(canonicalRoot);
    if (current.revisionId !== session.parentRevisionId) throw new Error("deck adoption parent is no longer current");
    if (options.mode === "manual" && options.userSignal !== "saved-and-closed") {
      throw new Error("manual adoption requires the explicit saved-and-closed signal");
    }
    const candidateRelativePath = revisionRelativePath(session.candidateRevisionId);
    if (session.candidateRelativePath !== candidateRelativePath) throw new Error("candidate deck path does not match its revision identity");
    const absolutePath = join(canonicalRoot, ...candidateRelativePath.split("/"));
    const inspected = await inspectLocalPptx(absolutePath);
    if (options.mode === "agent" && options.confirmedSha256 !== inspected.sha256) {
      throw new Error("agent confirmation does not bind the current candidate bytes");
    }
    const parent = await readLocalDeckRevision(canonicalRoot, session.parentRevisionId);
    const reconciled = reconcileSlideTopology(parent.slideTopology, inspected);
    if (reconciled.conflicts.length > 0) throw new Error("saved deck has ambiguous slide identities");
    let journal = await updateJournal(canonicalRoot, session.sessionId, (value) => ({
      ...value,
      adoption: {
        adoptionId: randomUUID(),
        adoptedAt: new Date().toISOString(),
        userSignal: options.mode === "manual" ? "saved-and-closed" : null,
        confirmedSha256: options.mode === "agent" ? inspected.sha256 : null,
      },
      entries: [...value.entries, { phase: "validated", at: new Date().toISOString() }],
    }));
    const manifest = await readProject(canonicalRoot);
    const revision = LocalDeckRevisionSchema.parse({
      schemaVersion: 1,
      revisionId: session.candidateRevisionId,
      parentRevisionId: session.parentRevisionId,
      projectId: manifest.projectId,
      projectRevisionId: manifest.currentRevision.id,
      reason: journal.reason,
      relativePath: session.candidateRelativePath,
      sha256: inspected.sha256,
      slideTopology: reconciled.topology,
      editableSlideIds: journal.editableSlideIds,
      changedSlideIds: journal.changedSlideIds,
      createdAt: new Date().toISOString(),
    });
    await writeSession(canonicalRoot, { ...session, state: "adopting" });
    return finalizeAdoption(canonicalRoot, session, revision, journal, options.operations);
  });
}

async function recoveryCandidate(root: string, sessionId: string): Promise<ResolvedCurrentDeckPointer | null> {
  const session = await readSession(root, sessionId);
  const journal = await readJournal(root, sessionId);
  if (session.state === "adopted") {
    const pointer = await readCurrentDeckPointerUnlocked(root);
    if (pointer.revisionId !== session.candidateRevisionId) {
      throw new Error("adopted deck session does not match the current pointer");
    }
    const currentDeck = CurrentDeckPointerSchema.parse({
      schemaVersion: pointer.schemaVersion,
      revisionId: pointer.revisionId,
      relativePath: pointer.relativePath,
      sha256: pointer.sha256,
      updatedAt: pointer.updatedAt,
    });
    await updateProject(root, (project) => {
      if (project.activeDeckEditSessionId !== null && project.activeDeckEditSessionId !== session.sessionId) {
        throw new Error("adopted deck cleanup conflicts with another active session");
      }
      return { ...project, currentDeck, activeDeckEditSessionId: null };
    });
    return pointer;
  }
  if (!journal.adoption || !journal.entries.some((entry) => entry.phase === "validated")) return null;
  let revision: ReturnType<typeof LocalDeckRevisionSchema.parse> | ResolvedLocalDeckRevision;
  try {
    const info = await lstat(join(revisionPath(root, session.candidateRevisionId), "revision.json"));
    if (info.isSymbolicLink() || !info.isFile()) throw new Error("deck revision record is unsafe");
    revision = await readLocalDeckRevision(root, session.candidateRevisionId);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const candidateRelativePath = revisionRelativePath(session.candidateRevisionId);
    if (session.candidateRelativePath !== candidateRelativePath) throw new Error("candidate deck path does not match its revision identity");
    const inspected = await inspectLocalPptx(join(root, ...candidateRelativePath.split("/")));
    if (session.mode === "agent" && journal.adoption.confirmedSha256 !== inspected.sha256) {
      throw new Error("recovered agent confirmation no longer binds the candidate bytes");
    }
    const parent = await readLocalDeckRevision(root, session.parentRevisionId);
    const reconciled = reconcileSlideTopology(parent.slideTopology, inspected);
    if (reconciled.conflicts.length > 0) throw new Error("recovered deck has ambiguous slide identities");
    const manifest = await readProject(root);
    revision = LocalDeckRevisionSchema.parse({
      schemaVersion: 1,
      revisionId: session.candidateRevisionId,
      parentRevisionId: session.parentRevisionId,
      projectId: manifest.projectId,
      projectRevisionId: manifest.currentRevision.id,
      reason: journal.reason,
      relativePath: session.candidateRelativePath,
      sha256: inspected.sha256,
      slideTopology: reconciled.topology,
      editableSlideIds: journal.editableSlideIds,
      changedSlideIds: journal.changedSlideIds,
      createdAt: journal.entries.find((entry) => entry.phase === "validated")!.at,
    });
  }
  return finalizeAdoption(root, session, revision, journal);
}

export async function recoverDeckAdoption(root: string): Promise<ResolvedCurrentDeckPointer | null> {
  return withProjectLease(root, "deck-revisions", async (canonicalRoot) => {
    await ensureDeckRoots(canonicalRoot);
    const sessionsRoot = join(canonicalRoot, "output", "deck-edit-sessions");
    for (const entry of await readdir(sessionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !UuidSchema.safeParse(entry.name).success) continue;
      const recovered = await recoveryCandidate(canonicalRoot, entry.name);
      if (recovered) return recovered;
    }
    return null;
  });
}

export async function rollbackCurrentDeck(
  root: string,
  revisionId: string,
): Promise<ResolvedCurrentDeckPointer> {
  const validRevisionId = UuidSchema.parse(revisionId);
  return withProjectLease(root, "deck-revisions", async (canonicalRoot) => {
    const manifest = await readProject(canonicalRoot);
    if (manifest.activeDeckEditSessionId !== null) throw new Error("cannot roll back while a deck edit session is active");
    const revision = await readLocalDeckRevision(canonicalRoot, validRevisionId);
    const pointer = await writeCurrentPointerOnly(canonicalRoot, {
      schemaVersion: 1,
      revisionId: revision.revisionId,
      relativePath: revision.relativePath,
      sha256: revision.sha256,
      updatedAt: new Date().toISOString(),
    });
    await updateProject(canonicalRoot, (project) => ({
      ...project,
      currentDeck: CurrentDeckPointerSchema.parse({
        schemaVersion: pointer.schemaVersion,
        revisionId: pointer.revisionId,
        relativePath: pointer.relativePath,
        sha256: pointer.sha256,
        updatedAt: pointer.updatedAt,
      }),
    }));
    return pointer;
  });
}
