import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import JSZip from "jszip";

import {
  adoptDeckCandidate,
  bootstrapInitialDeckRevision,
  createDeckCandidate,
  presentDeckCandidate,
  readCurrentDeckPointer,
  readLocalDeckRevision,
  recoverDeckAdoption,
  rollbackCurrentDeck,
} from "../src/deck-revisions/store.js";
import { DeckEditSessionSchema, LocalDeckRevisionSchema } from "../src/deck-revisions/schemas.js";
import { initializeProject } from "../src/project/initialize.js";
import { readProject, updateProject } from "../src/project/store.js";

const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const P14 = "http://schemas.microsoft.com/office/powerpoint/2010/main";

const digest = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");

async function fixture(t: TestContext) {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "superppt-deck-revisions-")));
  t.after(async () => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "project");
  const manifest = await initializeProject({ root, title: "Deck revisions" });
  const slideIds = [randomUUID(), randomUUID()];
  const revisionId = randomUUID();
  const relativePath = `output/deck-revisions/${revisionId}/deck.pptx`;
  const directory = join(root, "output", "deck-revisions", revisionId);
  await mkdir(directory, { recursive: true });
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"/>");
  zip.file("ppt/presentation.xml", `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels", `<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${R}/slide" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="${R}/slide" Target="slides/slide2.xml"/></Relationships>`);
  for (const [index, creationId] of [1001, 1002].entries()) {
    zip.file(`ppt/slides/slide${index + 1}.xml`, `<p:sld xmlns:p="${P}" xmlns:p14="${P14}"><p:cSld><p:spTree><p:nvGrpSpPr/></p:spTree><p:extLst><p:ext uri="{BB962C8B-B14F-4D97-AF65-F5344CB8AC3E}"><p14:creationId val="${creationId}"/></p:ext></p:extLst></p:cSld></p:sld>`);
    zip.file(`ppt/slides/_rels/slide${index + 1}.xml.rels`, `<Relationships xmlns="${REL}"/>`);
  }
  const deckBytes = await zip.generateAsync({ type: "nodebuffer" });
  const absolutePath = join(root, ...relativePath.split("/"));
  await writeFile(absolutePath, deckBytes);
  const topology = {
    schemaVersion: 1 as const,
    entries: slideIds.map((stableSlideId, position) => ({
      stableSlideId,
      slidePart: `ppt/slides/slide${position + 1}.xml`,
      position,
      management: "managed" as const,
      presentationSlideId: 256 + position,
      creationId: 1001 + position,
    })),
    deletedStableSlideIds: [],
    deletedSlideIdentities: [],
    sha256: "",
  };
  topology.sha256 = digest(JSON.stringify({
    schemaVersion: topology.schemaVersion,
    entries: topology.entries,
    deletedStableSlideIds: topology.deletedStableSlideIds,
    deletedSlideIdentities: topology.deletedSlideIdentities,
  }));
  const revision = {
    schemaVersion: 1 as const,
    revisionId,
    parentRevisionId: null,
    projectId: manifest.projectId,
    projectRevisionId: manifest.currentRevision.id,
    reason: "initial" as const,
    relativePath,
    sha256: digest(deckBytes),
    slideTopology: topology,
    editableSlideIds: [],
    changedSlideIds: slideIds,
    createdAt: new Date().toISOString(),
  };
  await writeFile(join(directory, "revision.json"), `${JSON.stringify(revision, null, 2)}\n`);
  const current = {
    schemaVersion: 1 as const,
    revisionId,
    relativePath,
    sha256: revision.sha256,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(join(root, "output", "current.json"), `${JSON.stringify(current, null, 2)}\n`);
  await updateProject(root, (project) => ({ ...project, currentDeck: current, activeDeckEditSessionId: null }));
  return { root, slideIds, revision, current: { ...current, absolutePath }, deckBytes };
}

async function userEditedFixture(source: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(source);
  const xml = await zip.file("ppt/slides/slide2.xml")!.async("string");
  zip.file("ppt/slides/slide2.xml", xml.replace("<p:nvGrpSpPr/>", "<p:nvGrpSpPr/><p:sp><p:nvSpPr/></p:sp>"));
  return zip.generateAsync({ type: "nodebuffer" });
}

async function presentManualCandidate(
  root: string,
  candidate: { sessionId: string; targetSlideId: string },
): Promise<void> {
  await presentDeckCandidate(root, {
    sessionId: candidate.sessionId,
    mode: "manual",
    targetSlideId: candidate.targetSlideId,
    state: "external-editing",
  });
}

test("project manifest tracks only the current deck pointer and active session identity", async (t) => {
  const value = await fixture(t);
  const manifest = await readProject(value.root);
  assert.equal(manifest.currentDeck?.revisionId, value.revision.revisionId);
  assert.equal(manifest.activeDeckEditSessionId, null);
  assert.equal("deckRevisionState" in manifest, false);
});

test("revision and session schemas bind deck path components to their own revision identities", async (t) => {
  const value = await fixture(t);
  assert.equal(LocalDeckRevisionSchema.safeParse({
    ...value.revision,
    revisionId: randomUUID(),
  }).success, false);
  const candidate = await createDeckCandidate(value.root, {
    sourceRevisionId: value.current.revisionId,
    reason: "manual-edit",
    changedSlideIds: [value.slideIds[0]!],
    editableSlideIds: [],
    targetSlideId: value.slideIds[0]!,
    mode: "manual",
  });
  const { absolutePath: _absolutePath, ...persistedCandidate } = candidate;
  assert.equal(DeckEditSessionSchema.safeParse({
    ...persistedCandidate,
    candidateRelativePath: value.current.relativePath,
  }).success, false);
});

test("adoption rejects a persisted candidate path alias instead of reading another revision", async (t) => {
  const value = await fixture(t);
  const candidate = await createDeckCandidate(value.root, {
    sourceRevisionId: value.current.revisionId,
    reason: "manual-edit",
    changedSlideIds: [value.slideIds[0]!],
    editableSlideIds: [],
    targetSlideId: value.slideIds[0]!,
    mode: "manual",
  });
  const path = join(value.root, "output", "deck-edit-sessions", candidate.sessionId, "session.json");
  const persisted = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  await writeFile(path, `${JSON.stringify({ ...persisted, candidateRelativePath: value.current.relativePath }, null, 2)}\n`);
  await assert.rejects(adoptDeckCandidate(value.root, {
    sessionId: candidate.sessionId,
    mode: "manual",
    userSignal: "saved-and-closed",
  }), /candidate.*path|revision.*path|identity/i);
  assert.equal((await readCurrentDeckPointer(value.root)).revisionId, value.current.revisionId);
});

test("manual adoption moves only the current pointer and preserves saved bytes", async (t) => {
  const value = await fixture(t);
  const candidate = await createDeckCandidate(value.root, {
    sourceRevisionId: value.current.revisionId,
    reason: "manual-edit",
    changedSlideIds: [value.slideIds[1]!],
    editableSlideIds: [value.slideIds[1]!],
    targetSlideId: value.slideIds[1]!,
    mode: "manual",
  });
  await presentManualCandidate(value.root, candidate);
  await assert.rejects(readFile(join(value.root, "output", "deck-revisions", candidate.candidateRevisionId, "revision.json")), { code: "ENOENT" });
  assert.equal((await readCurrentDeckPointer(value.root)).revisionId, value.current.revisionId);
  const userSavedBytes = await userEditedFixture(await readFile(candidate.absolutePath));
  await writeFile(candidate.absolutePath, userSavedBytes);

  await assert.rejects(adoptDeckCandidate(value.root, {
    sessionId: candidate.sessionId,
    mode: "manual",
    userSignal: "saved" as never,
  }), /saved-and-closed/);
  const adopted = await adoptDeckCandidate(value.root, {
    sessionId: candidate.sessionId,
    mode: "manual",
    userSignal: "saved-and-closed",
  });

  assert.deepEqual(await readFile(candidate.absolutePath), userSavedBytes);
  assert.equal(adopted.revisionId, candidate.candidateRevisionId);
  assert.equal((await readCurrentDeckPointer(value.root)).sha256, adopted.sha256);
  assert.deepEqual(await readFile(value.current.absolutePath), value.deckBytes);
  assert.equal((await readLocalDeckRevision(value.root, adopted.revisionId)).sha256, adopted.sha256);
  const session = JSON.parse(await readFile(join(value.root, "output", "deck-edit-sessions", candidate.sessionId, "session.json"), "utf8")) as { state: string };
  assert.equal(session.state, "adopted");
});

test("agent adoption requires confirmation of the exact candidate bytes", async (t) => {
  const value = await fixture(t);
  const candidate = await createDeckCandidate(value.root, {
    sourceRevisionId: value.current.revisionId,
    reason: "agent-edit",
    changedSlideIds: [value.slideIds[0]!],
    editableSlideIds: [],
    targetSlideId: value.slideIds[0]!,
    mode: "agent",
  });
  await presentDeckCandidate(value.root, {
    sessionId: candidate.sessionId,
    mode: "agent",
    targetSlideId: candidate.targetSlideId,
    state: "awaiting-confirmation",
  });
  await assert.rejects(adoptDeckCandidate(value.root, {
    sessionId: candidate.sessionId,
    mode: "agent",
    confirmedSha256: "0".repeat(64),
  }), /exact candidate|confirmation/i);
  assert.equal((await readCurrentDeckPointer(value.root)).revisionId, value.current.revisionId);
});

test("rollback changes the pointer without rewriting either deck", async (t) => {
  const value = await fixture(t);
  const candidate = await createDeckCandidate(value.root, {
    sourceRevisionId: value.current.revisionId,
    reason: "manual-edit",
    changedSlideIds: [value.slideIds[1]!],
    editableSlideIds: [],
    targetSlideId: value.slideIds[1]!,
    mode: "manual",
  });
  await presentManualCandidate(value.root, candidate);
  const edited = await userEditedFixture(await readFile(candidate.absolutePath));
  await writeFile(candidate.absolutePath, edited);
  await adoptDeckCandidate(value.root, { sessionId: candidate.sessionId, mode: "manual", userSignal: "saved-and-closed" });
  const paths = [value.current.absolutePath, candidate.absolutePath];
  const before = await Promise.all(paths.map((path) => readFile(path)));

  const pointer = await rollbackCurrentDeck(value.root, value.current.revisionId);
  assert.equal(pointer.revisionId, value.current.revisionId);
  assert.deepEqual(await Promise.all(paths.map((path) => readFile(path))), before);
});

test("interrupted adoption recovery keeps revision records immutable and finishes one pointer", async (t) => {
  for (const checkpoint of ["revision-written", "evidence-written", "pointer-written", "session-adopted"] as const) {
    await t.test(checkpoint, async (st) => {
      const value = await fixture(st);
      const candidate = await createDeckCandidate(value.root, {
        sourceRevisionId: value.current.revisionId,
        reason: "manual-edit",
        changedSlideIds: [value.slideIds[0]!],
        editableSlideIds: [],
        targetSlideId: value.slideIds[0]!,
        mode: "manual",
      });
      await presentManualCandidate(value.root, candidate);
      await assert.rejects(adoptDeckCandidate(value.root, {
        sessionId: candidate.sessionId,
        mode: "manual",
        userSignal: "saved-and-closed",
        operations: { checkpoint: (phase) => { if (phase === checkpoint) throw new Error("injected adoption crash"); } },
      }), /injected adoption crash/);
      const revisionsRoot = join(value.root, "output", "deck-revisions");
      const records = async () => Promise.all((await readdir(revisionsRoot)).sort().map((id) => readFile(join(revisionsRoot, id, "revision.json")).catch(() => Buffer.alloc(0))));
      const before = await records();

      const pointer = await recoverDeckAdoption(value.root);
      assert.equal(pointer?.revisionId, candidate.candidateRevisionId);
      assert.deepEqual(await records(), before);
      assert.equal((await readCurrentDeckPointer(value.root)).revisionId, candidate.candidateRevisionId);
      const manifest = await readProject(value.root);
      assert.equal(manifest.activeDeckEditSessionId, null);
      assert.equal(manifest.currentDeck?.revisionId, candidate.candidateRevisionId);
      assert.deepEqual((await readdir(join(value.root, "output"))).filter((name) => /^current.*\.json$/.test(name)), ["current.json"]);
    });
  }
});

test("validated manual adoption recovery rejects candidate bytes changed after the accepted stable read", async (t) => {
  const value = await fixture(t);
  const candidate = await createDeckCandidate(value.root, {
    sourceRevisionId: value.current.revisionId,
    reason: "manual-edit",
    changedSlideIds: [value.slideIds[1]!],
    editableSlideIds: [value.slideIds[1]!],
    targetSlideId: value.slideIds[1]!,
    mode: "manual",
  });
  await presentManualCandidate(value.root, candidate);
  const acceptedBytes = await userEditedFixture(await readFile(candidate.absolutePath));
  await writeFile(candidate.absolutePath, acceptedBytes);
  await assert.rejects(adoptDeckCandidate(value.root, {
    sessionId: candidate.sessionId,
    mode: "manual",
    userSignal: "saved-and-closed",
    operations: {
      checkpoint: (phase) => {
        if ((phase as string) === "validated") throw new Error("injected validated adoption crash");
      },
    },
  }), /injected validated adoption crash/);

  const changedAfterValidation = await userEditedFixture(acceptedBytes);
  await writeFile(candidate.absolutePath, changedAfterValidation);
  await assert.rejects(recoverDeckAdoption(value.root), /validated|changed|bind|sha/i);
  await assert.rejects(adoptDeckCandidate(value.root, {
    sessionId: candidate.sessionId,
    mode: "manual",
    userSignal: "saved-and-closed",
  }), /validated|changed|bind|sha/i);
  assert.equal((await readCurrentDeckPointer(value.root)).revisionId, value.current.revisionId);
  assert.deepEqual(await readFile(candidate.absolutePath), changedAfterValidation);
  await assert.rejects(
    readFile(join(value.root, "output", "deck-revisions", candidate.candidateRevisionId, "revision.json")),
    { code: "ENOENT" },
  );
});

test("validated adoption journal recovers unchanged manual and Agent candidates from its exact revision snapshot", async (t) => {
  for (const mode of ["manual", "agent"] as const) {
    await t.test(mode, async (st) => {
      const value = await fixture(st);
      const candidate = await createDeckCandidate(value.root, {
        sourceRevisionId: value.current.revisionId,
        reason: mode === "manual" ? "manual-edit" : "agent-edit",
        changedSlideIds: [value.slideIds[0]!],
        editableSlideIds: [value.slideIds[0]!],
        targetSlideId: value.slideIds[0]!,
        mode,
      });
      if (mode === "manual") {
        await presentManualCandidate(value.root, candidate);
      } else {
        await presentDeckCandidate(value.root, {
          sessionId: candidate.sessionId,
          mode: "agent",
          targetSlideId: candidate.targetSlideId,
          state: "awaiting-confirmation",
        });
      }
      await assert.rejects(adoptDeckCandidate(value.root, {
        sessionId: candidate.sessionId,
        mode,
        ...(mode === "manual"
          ? { userSignal: "saved-and-closed" as const }
          : { confirmedSha256: candidate.preparedSha256 }),
        operations: {
          checkpoint: (phase) => {
            if ((phase as string) === "validated") throw new Error("injected validated adoption crash");
          },
        },
      }), /injected validated adoption crash/);
      const journal = JSON.parse(await readFile(
        join(value.root, "output", "deck-edit-sessions", candidate.sessionId, "journal.json"),
        "utf8",
      )) as {
        adoption: {
          validatedSha256: string;
          reconciledSlideTopology: { sha256: string };
          validatedRevision: { sha256: string; slideTopology: { sha256: string } };
        };
      };
      assert.equal(journal.adoption.validatedSha256, candidate.preparedSha256);
      assert.equal(journal.adoption.reconciledSlideTopology.sha256, value.revision.slideTopology.sha256);
      assert.equal(journal.adoption.validatedRevision.sha256, candidate.preparedSha256);
      assert.equal(
        journal.adoption.validatedRevision.slideTopology.sha256,
        journal.adoption.reconciledSlideTopology.sha256,
      );

      const recovered = await recoverDeckAdoption(value.root);
      assert.equal(recovered?.revisionId, candidate.candidateRevisionId);
      assert.equal(recovered?.sha256, candidate.preparedSha256);
      assert.equal((await readCurrentDeckPointer(value.root)).revisionId, candidate.candidateRevisionId);
    });
  }
});

test("recovery skips a historical adopted session after rollback", async (t) => {
  const value = await fixture(t);
  const candidate = await createDeckCandidate(value.root, {
    sourceRevisionId: value.current.revisionId,
    reason: "manual-edit",
    changedSlideIds: [value.slideIds[0]!],
    editableSlideIds: [],
    targetSlideId: value.slideIds[0]!,
    mode: "manual",
  });
  await presentManualCandidate(value.root, candidate);
  await adoptDeckCandidate(value.root, { sessionId: candidate.sessionId, mode: "manual", userSignal: "saved-and-closed" });
  await rollbackCurrentDeck(value.root, value.current.revisionId);
  assert.equal(await recoverDeckAdoption(value.root), null);
  assert.equal((await readCurrentDeckPointer(value.root)).revisionId, value.current.revisionId);
  assert.equal((await readProject(value.root)).activeDeckEditSessionId, null);
});

test("recovery ignores multiple historical sessions and completes only the active adopted crash window", async (t) => {
  const value = await fixture(t);
  let sourceRevisionId: string = value.current.revisionId;
  for (let index = 0; index < 2; index += 1) {
    const historical = await createDeckCandidate(value.root, {
      sourceRevisionId,
      reason: "manual-edit",
      changedSlideIds: [value.slideIds[index]!],
      editableSlideIds: [],
      targetSlideId: value.slideIds[index]!,
      mode: "manual",
    });
    await presentManualCandidate(value.root, historical);
    const adopted = await adoptDeckCandidate(value.root, { sessionId: historical.sessionId, mode: "manual", userSignal: "saved-and-closed" });
    sourceRevisionId = adopted.revisionId;
  }
  const active = await createDeckCandidate(value.root, {
    sourceRevisionId,
    reason: "manual-edit",
    changedSlideIds: [value.slideIds[0]!],
    editableSlideIds: [],
    targetSlideId: value.slideIds[0]!,
    mode: "manual",
  });
  await presentManualCandidate(value.root, active);
  await assert.rejects(adoptDeckCandidate(value.root, {
    sessionId: active.sessionId,
    mode: "manual",
    userSignal: "saved-and-closed",
    operations: { checkpoint: (phase) => { if (phase === "session-adopted") throw new Error("active cleanup crash"); } },
  }), /active cleanup crash/);

  const recovered = await recoverDeckAdoption(value.root);
  assert.equal(recovered?.revisionId, active.candidateRevisionId);
  assert.equal((await readProject(value.root)).activeDeckEditSessionId, null);
});

test("adopted fast-path idempotently finishes its active manifest mirror", async (t) => {
  const value = await fixture(t);
  const candidate = await createDeckCandidate(value.root, {
    sourceRevisionId: value.current.revisionId,
    reason: "manual-edit",
    changedSlideIds: [value.slideIds[0]!],
    editableSlideIds: [],
    targetSlideId: value.slideIds[0]!,
    mode: "manual",
  });
  await presentManualCandidate(value.root, candidate);
  await assert.rejects(adoptDeckCandidate(value.root, {
    sessionId: candidate.sessionId,
    mode: "manual",
    userSignal: "saved-and-closed",
    operations: { checkpoint: (phase) => { if (phase === "session-adopted") throw new Error("active cleanup crash"); } },
  }), /active cleanup crash/);
  const pointer = await adoptDeckCandidate(value.root, {
    sessionId: candidate.sessionId,
    mode: "manual",
    userSignal: "saved-and-closed",
  });
  const manifest = await readProject(value.root);
  assert.equal(pointer.revisionId, candidate.candidateRevisionId);
  assert.equal(manifest.currentDeck?.revisionId, candidate.candidateRevisionId);
  assert.equal(manifest.activeDeckEditSessionId, null);
});

async function initialBootstrapFixture(t: TestContext) {
  const value = await fixture(t);
  await rm(join(value.root, "output", "current.json"));
  await updateProject(value.root, (project) => ({ ...project, currentDeck: null }));
  const sourceId = randomUUID();
  const sourceRoot = join(value.root, "output", "candidates", sourceId);
  await mkdir(sourceRoot, { recursive: true });
  const sourceAbsolutePath = join(sourceRoot, "deck.pptx");
  await writeFile(sourceAbsolutePath, value.deckBytes);
  return {
    ...value,
    options: {
      revisionId: randomUUID(),
      projectRevisionId: value.revision.projectRevisionId,
      sourceAbsolutePath,
      slideTopology: value.revision.slideTopology,
      changedSlideIds: value.slideIds,
    },
  };
}

test("initial bootstrap retry converges from every durable publication checkpoint", async (t) => {
  for (const checkpoint of ["directory-created", "deck-copied", "revision-written", "pointer-written", "manifest-updated"] as const) {
    await t.test(checkpoint, async (st) => {
      const value = await initialBootstrapFixture(st);
      await assert.rejects(bootstrapInitialDeckRevision(value.root, {
        ...value.options,
        operations: { checkpoint: (phase) => { if (phase === checkpoint) throw new Error("bootstrap crash"); } },
      }), /bootstrap crash/);
      const pointer = await bootstrapInitialDeckRevision(value.root, value.options);
      assert.equal(pointer.revisionId, value.options.revisionId);
      const manifest = await readProject(value.root);
      assert.equal(manifest.currentDeck?.revisionId, value.options.revisionId);
      assert.equal((await readLocalDeckRevision(value.root, value.options.revisionId)).sha256, pointer.sha256);
    });
  }
});

test("initial bootstrap rejects mismatched durable residues", async (t) => {
  for (const kind of ["deck", "revision", "pointer"] as const) {
    await t.test(kind, async (st) => {
      const value = await initialBootstrapFixture(st);
      const checkpoint = kind === "deck" ? "deck-copied" : kind === "revision" ? "revision-written" : "pointer-written";
      await assert.rejects(bootstrapInitialDeckRevision(value.root, {
        ...value.options,
        operations: { checkpoint: (phase) => { if (phase === checkpoint) throw new Error("bootstrap crash"); } },
      }), /bootstrap crash/);
      const revisionRoot = join(value.root, "output", "deck-revisions", value.options.revisionId);
      if (kind === "deck") await writeFile(join(revisionRoot, "deck.pptx"), "tampered deck");
      if (kind === "revision") {
        const path = join(revisionRoot, "revision.json");
        const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
        await writeFile(path, `${JSON.stringify({ ...record, sha256: "0".repeat(64) }, null, 2)}\n`);
      }
      if (kind === "pointer") {
        const other = randomUUID();
        const path = join(value.root, "output", "current.json");
        const pointer = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
        await writeFile(path, `${JSON.stringify({ ...pointer, revisionId: other, relativePath: `output/deck-revisions/${other}/deck.pptx` }, null, 2)}\n`);
      }
      await assert.rejects(bootstrapInitialDeckRevision(value.root, value.options), /mismatch|changed|bind|invalid|unsafe|package|different bytes|regular file/i);
      assert.equal((await readProject(value.root)).currentDeck, null);
    });
  }
});
