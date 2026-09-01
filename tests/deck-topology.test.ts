import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import JSZip from "jszip";

import { publishInitialSlideIdentities } from "../src/deck-revisions/identity.js";
import { inspectLocalPptx } from "../src/deck-revisions/inspect.js";
import { scanOoxmlRanges } from "../src/deck-revisions/ooxml.js";
import { SlideTopologySchema, type SlideTopology } from "../src/deck-revisions/schemas.js";
import { reconcileSlideTopology } from "../src/deck-revisions/topology.js";
import { initializeProject } from "../src/project/initialize.js";

const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const P14 = "http://schemas.microsoft.com/office/powerpoint/2010/main";

function signedTopology(value: Omit<SlideTopology, "sha256" | "deletedSlideIdentities"> & {
  deletedSlideIdentities?: SlideTopology["deletedSlideIdentities"];
}): SlideTopology {
  const normalized = { ...value, deletedSlideIdentities: value.deletedSlideIdentities ?? [] };
  return { ...normalized, sha256: createHash("sha256").update(JSON.stringify(normalized)).digest("hex") };
}

async function projectRoot(t: TestContext): Promise<string> {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "superppt-deck-topology-")));
  t.after(async () => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "project");
  await initializeProject({ root, title: "Deck topology" });
  return root;
}

async function writeDeck(root: string, revisionId: string, slides: Array<{
  presentationId: number;
  relationshipId: string;
  partNumber: number;
  creationId?: number;
  identityXml?: string;
}>): Promise<string> {
  const revisionRoot = join(root, "output", "deck-revisions", revisionId);
  await mkdir(revisionRoot, { recursive: true });
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"/>");
  zip.file("ppt/presentation.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<deck:presentation xmlns:deck="${P}" xmlns:rel="${R}"><deck:sldIdLst>${slides.map((slide) =>
    `<deck:sldId id="${slide.presentationId}" rel:id="${slide.relationshipId}"/>`).join("")}</deck:sldIdLst></deck:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels", `<Relationships xmlns="${REL}">${slides.map((slide) =>
    `<Relationship Id="${slide.relationshipId}" Type="${R}/slide" Target="slides/slide${slide.partNumber}.xml"/>`).join("")}</Relationships>`);
  for (const slide of slides) {
    const identity = slide.identityXml ?? (slide.creationId === undefined
      ? `<deck:extLst><deck:ext uri="{UNKNOWN-EXTENSION}"><mystery:payload keep="yes"/></deck:ext></deck:extLst>`
      : `<deck:extLst><deck:ext uri="{BB962C8B-B14F-4D97-AF65-F5344CB8AC3E}"><office14:creationId val="${slide.creationId}"/></deck:ext></deck:extLst>`);
    zip.file(`ppt/slides/slide${slide.partNumber}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<deck:sld xmlns:deck="${P}" xmlns:office14="${P14}" xmlns:mystery="urn:unknown"><deck:cSld name="中文 🌌"><deck:spTree/><mystery:data keep="yes"/>${identity}</deck:cSld></deck:sld>`);
    zip.file(`ppt/slides/_rels/slide${slide.partNumber}.xml.rels`, `<Relationships xmlns="${REL}"/>`);
  }
  const path = join(revisionRoot, "deck.pptx");
  await writeFile(path, await zip.generateAsync({ type: "nodebuffer" }));
  return path;
}

test("namespace-aware OOXML ranges preserve original Unicode and self-closing relationship tags", () => {
  const xml = `<x:root xmlns:x="urn:root" xmlns:r="${REL}" xmlns:u="urn:unknown">中文🌌<r:Relationship Id="rId1" Target="slides/slide1.xml"/><u:ext keep="yes"/></x:root>`;
  const index = scanOoxmlRanges(xml);
  const relationship = index.elements.find((entry) => entry.namespaceUri === REL && entry.localName === "Relationship");
  assert.ok(relationship);
  assert.equal(xml.slice(relationship.start, relationship.end), `<r:Relationship Id="rId1" Target="slides/slide1.xml"/>`);
  assert.equal(relationship.selfClosing, true);
  assert.equal(relationship.attributes.find((attribute) => attribute.localName === "Target")?.value, "slides/slide1.xml");
  assert.equal(index.elements.some((entry) => entry.namespaceUri === "urn:unknown" && entry.localName === "ext"), true);
});

test("identity publication expands self-closing official containers inside their selected raw ranges", async (t) => {
  const root = await projectRoot(t);
  for (const [name, identityXml] of [
    ["extension-list", `<deck:extLst/>`],
    ["official-extension", `<deck:extLst><deck:ext uri="{BB962C8B-B14F-4D97-AF65-F5344CB8AC3E}"/></deck:extLst>`],
  ] as const) {
    await t.test(name, async () => {
      const path = await writeDeck(root, randomUUID(), [{
        presentationId: 256,
        relationshipId: "rId1",
        partNumber: 1,
        identityXml,
      }]);
      const stableSlideId = randomUUID();
      await publishInitialSlideIdentities(path, [{ stableSlideId, position: 0 }]);
      const zip = await JSZip.loadAsync(await readFile(path));
      const xml = await zip.file("ppt/slides/slide1.xml")!.async("string");
      assert.match(xml, /<deck:extLst[^>]*>.*<deck:ext uri="\{BB962C8B-B14F-4D97-AF65-F5344CB8AC3E\}">.*<office14:creationId val="[1-9][0-9]*"\/>.*<\/deck:ext>.*<\/deck:extLst>/s);
      assert.equal((await inspectLocalPptx(path)).slides[0]!.creationId !== null, true);
    });
  }
});

test("public inspection and identity publication reject an unowned project-shaped directory without mutation", async (t) => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "superppt-unowned-deck-")));
  t.after(async () => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "not-a-project");
  const path = await writeDeck(root, randomUUID(), [{
    presentationId: 256,
    relationshipId: "rId1",
    partNumber: 1,
  }]);
  const before = await readFile(path);
  await assert.rejects(inspectLocalPptx(path), /not owned by SuperPPT/i);
  await assert.rejects(
    publishInitialSlideIdentities(path, [{ stableSlideId: randomUUID(), position: 0 }]),
    /not owned by SuperPPT/i,
  );
  assert.deepEqual(await readFile(path), before);
});

test("initial identity publication uses official creation IDs and preserves unrelated XML", async (t) => {
  const root = await projectRoot(t);
  const revisionId = randomUUID();
  const path = await writeDeck(root, revisionId, [
    { presentationId: 256, relationshipId: "rId1", partNumber: 1 },
    { presentationId: 257, relationshipId: "rId2", partNumber: 2, creationId: 9002 },
  ]);
  const before = await JSZip.loadAsync(await readFile(path));
  const existing = await before.file("ppt/slides/slide2.xml")!.async("string");
  const stableSlideIds = [randomUUID(), randomUUID()];

  const topology = await publishInitialSlideIdentities(path, stableSlideIds.map((stableSlideId, position) => ({ stableSlideId, position })));
  const inspected = await inspectLocalPptx(path);
  const after = await JSZip.loadAsync(await readFile(path));
  const injected = await after.file("ppt/slides/slide1.xml")!.async("string");

  assert.deepEqual(topology.entries.map((entry) => entry.stableSlideId), stableSlideIds);
  assert.equal(inspected.slides[0]!.creationId, topology.entries[0]!.creationId);
  assert.equal(inspected.slides[1]!.creationId, 9002);
  assert.match(injected, /uri="\{BB962C8B-B14F-4D97-AF65-F5344CB8AC3E\}"/);
  const creation = scanOoxmlRanges(injected).elements.find((entry) =>
    entry.namespaceUri === P14 && entry.localName === "creationId");
  assert.ok(creation);
  assert.match(creation.attributes.find((attribute) => attribute.localName === "val")?.value ?? "", /^[1-9][0-9]*$/);
  assert.match(injected, /<mystery:data keep="yes"\/>/);
  assert.match(injected, /<mystery:payload keep="yes"\/>/);
  assert.equal(await after.file("ppt/slides/slide2.xml")!.async("string"), existing);
});

test("inspection rejects unsafe relationship evidence without writing the deck", async (t) => {
  const root = await projectRoot(t);
  const path = await writeDeck(root, randomUUID(), [
    { presentationId: 256, relationshipId: "rId1", partNumber: 1, creationId: 7001 },
  ]);
  const zip = await JSZip.loadAsync(await readFile(path));
  zip.file("ppt/_rels/presentation.xml.rels", `<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${R}/slide" Target="../outside.xml"/></Relationships>`);
  const corrupt = await zip.generateAsync({ type: "nodebuffer" });
  await writeFile(path, corrupt);

  await assert.rejects(inspectLocalPptx(path), /traversal|slide target|unsafe/i);
  assert.deepEqual(await readFile(path), corrupt);
});

test("inspection rejects external, duplicate, and symlinked slide identity evidence", async (t) => {
  const root = await projectRoot(t);
  const external = await writeDeck(root, randomUUID(), [
    { presentationId: 256, relationshipId: "rId1", partNumber: 1, creationId: 7101 },
  ]);
  const externalZip = await JSZip.loadAsync(await readFile(external));
  externalZip.file("ppt/_rels/presentation.xml.rels", `<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${R}/slide" Target="https://example.invalid/slide.xml" TargetMode="External"/></Relationships>`);
  await writeFile(external, await externalZip.generateAsync({ type: "nodebuffer" }));
  await assert.rejects(inspectLocalPptx(external), /external slide target/i);

  const duplicate = await writeDeck(root, randomUUID(), [
    { presentationId: 256, relationshipId: "rId1", partNumber: 1, creationId: 7201 },
    { presentationId: 257, relationshipId: "rId2", partNumber: 2, creationId: 7201 },
  ]);
  await assert.rejects(inspectLocalPptx(duplicate), /duplicate persistent creation/i);

  const ownedRevisionId = randomUUID();
  const owned = await writeDeck(root, ownedRevisionId, [
    { presentationId: 256, relationshipId: "rId1", partNumber: 1, creationId: 7301 },
  ]);
  const aliasRevisionId = randomUUID();
  const aliasRoot = join(root, "output", "deck-revisions", aliasRevisionId);
  await symlink(join(root, "output", "deck-revisions", ownedRevisionId), aliasRoot);
  await assert.rejects(inspectLocalPptx(join(aliasRoot, "deck.pptx")), /canonical|symlink/i);
  assert.ok((await readFile(owned)).length > 0);
});

test("topology reconciliation preserves moved identities and records deleted and unmanaged slides", async () => {
  const first = randomUUID();
  const second = randomUUID();
  const previous = signedTopology({
    schemaVersion: 1 as const,
    entries: [
      { stableSlideId: first, slidePart: "ppt/slides/slide1.xml", position: 0, management: "managed" as const, presentationSlideId: 256, creationId: 1001 },
      { stableSlideId: second, slidePart: "ppt/slides/slide2.xml", position: 1, management: "managed" as const, presentationSlideId: 257, creationId: 1002 },
    ],
    deletedStableSlideIds: [],
  });
  const inspected = {
    slides: [
      { position: 0, slidePart: "ppt/slides/slide9.xml", presentationSlideId: 257, relationshipId: "rId2", relationshipTarget: "slides/slide9.xml", creationId: 1002, xmlSha256: "b".repeat(64), relationshipsSha256: null },
      { position: 1, slidePart: "ppt/slides/slide3.xml", presentationSlideId: 300, relationshipId: "rId3", relationshipTarget: "slides/slide3.xml", creationId: 2003, xmlSha256: "c".repeat(64), relationshipsSha256: null },
    ],
  };

  const reconciled = reconcileSlideTopology(previous, inspected);
  assert.deepEqual(reconciled.conflicts, []);
  assert.equal(reconciled.topology.entries[0]!.stableSlideId, second);
  assert.equal(reconciled.topology.entries[0]!.position, 0);
  assert.equal(reconciled.topology.entries[1]!.management, "unmanaged");
  assert.deepEqual(reconciled.topology.deletedStableSlideIds, [first]);
  assert.deepEqual(reconciled.movements, [{ stableSlideId: second, from: 1, to: 0 }]);
});

test("WPS reconciliation preserves presentation identities when every creation ID is removed", () => {
  const deleted = randomUUID();
  const moved = randomUUID();
  const retained = randomUUID();
  const previous = signedTopology({
    schemaVersion: 1 as const,
    entries: [
      { stableSlideId: deleted, slidePart: "ppt/slides/slide1.xml", position: 0, management: "managed" as const, presentationSlideId: 256, creationId: 1001 },
      { stableSlideId: moved, slidePart: "ppt/slides/slide2.xml", position: 1, management: "managed" as const, presentationSlideId: 257, creationId: 1002 },
      { stableSlideId: retained, slidePart: "ppt/slides/slide3.xml", position: 2, management: "managed" as const, presentationSlideId: 258, creationId: 1003 },
    ],
    deletedStableSlideIds: [],
  });
  const wpsInspection = { slides: [
    { position: 0, slidePart: "ppt/slides/slide2.xml", presentationSlideId: 257, relationshipId: "rId2", relationshipTarget: "slides/slide2.xml", creationId: null, xmlSha256: "a".repeat(64), relationshipsSha256: null },
    { position: 1, slidePart: "ppt/slides/slide4.xml", presentationSlideId: 259, relationshipId: "rId4", relationshipTarget: "slides/slide4.xml", creationId: null, xmlSha256: "b".repeat(64), relationshipsSha256: null },
    { position: 2, slidePart: "ppt/slides/slide3.xml", presentationSlideId: 258, relationshipId: "rId3", relationshipTarget: "slides/slide3.xml", creationId: null, xmlSha256: "c".repeat(64), relationshipsSha256: null },
  ] };

  const adopted = reconcileSlideTopology(previous, wpsInspection);
  assert.deepEqual(adopted.conflicts, []);
  assert.deepEqual(adopted.topology.entries.map(({ stableSlideId, presentationSlideId, creationId, management }) => ({
    stableSlideId,
    presentationSlideId,
    creationId,
    management,
  })), [
    { stableSlideId: moved, presentationSlideId: 257, creationId: null, management: "managed" },
    { stableSlideId: adopted.topology.entries[1]!.stableSlideId, presentationSlideId: 259, creationId: null, management: "unmanaged" },
    { stableSlideId: retained, presentationSlideId: 258, creationId: null, management: "managed" },
  ]);
  assert.deepEqual(adopted.topology.deletedSlideIdentities, [
    { stableSlideId: deleted, presentationSlideId: 256, creationId: 1001 },
  ]);
  assert.deepEqual(adopted.movements, [{ stableSlideId: moved, from: 1, to: 0 }]);

  const repeated = reconcileSlideTopology(adopted.topology, wpsInspection);
  assert.deepEqual(repeated.conflicts, []);
  assert.deepEqual(
    repeated.topology.entries.map((entry) => entry.stableSlideId),
    adopted.topology.entries.map((entry) => entry.stableSlideId),
  );

  const removedNullCreation = reconcileSlideTopology(repeated.topology, { slides: [
    wpsInspection.slides[0]!,
    { ...wpsInspection.slides[2]!, position: 1 },
  ] });
  assert.deepEqual(removedNullCreation.conflicts, []);
  assert.deepEqual(removedNullCreation.topology.deletedSlideIdentities, [
    { stableSlideId: deleted, presentationSlideId: 256, creationId: 1001 },
    { stableSlideId: adopted.topology.entries[1]!.stableSlideId, presentationSlideId: 259, creationId: null },
  ]);
});

test("presentation tombstones reject reappearance even when creation evidence is null", () => {
  const survivor = randomUUID();
  const deleted = randomUUID();
  const previous = signedTopology({
    schemaVersion: 1 as const,
    entries: [
      { stableSlideId: survivor, slidePart: "ppt/slides/slide2.xml", position: 0, management: "managed" as const, presentationSlideId: 257, creationId: null },
    ],
    deletedStableSlideIds: [deleted],
    deletedSlideIdentities: [
      { stableSlideId: deleted, presentationSlideId: 256, creationId: null },
    ],
  });
  const reconciled = reconcileSlideTopology(previous, { slides: [
    { position: 0, slidePart: "ppt/slides/slide2.xml", presentationSlideId: 257, relationshipId: "rId2", relationshipTarget: "slides/slide2.xml", creationId: null, xmlSha256: "a".repeat(64), relationshipsSha256: null },
    { position: 1, slidePart: "ppt/slides/slide1.xml", presentationSlideId: 256, relationshipId: "rId1", relationshipTarget: "slides/slide1.xml", creationId: null, xmlSha256: "b".repeat(64), relationshipsSha256: null },
  ] });
  assert.match(reconciled.conflicts.join("\n"), /deleted slide identity reappeared/i);
  assert.deepEqual(reconciled.topology, previous);
});

test("non-null creation evidence cannot attach to a presentation-only known slide", () => {
  const stableSlideId = randomUUID();
  const previous = signedTopology({
    schemaVersion: 1 as const,
    entries: [
      { stableSlideId, slidePart: "ppt/slides/slide2.xml", position: 0, management: "managed" as const, presentationSlideId: 257, creationId: null },
    ],
    deletedStableSlideIds: [],
  });
  const reconciled = reconcileSlideTopology(previous, { slides: [{
    position: 0,
    slidePart: "ppt/slides/slide2.xml",
    presentationSlideId: 257,
    relationshipId: "rId2",
    relationshipTarget: "slides/slide2.xml",
    creationId: 9999,
    xmlSha256: "c".repeat(64),
    relationshipsSha256: null,
  }] });
  assert.match(reconciled.conflicts.join("\n"), /conflicting identity evidence/i);
  assert.deepEqual(reconciled.topology, previous);
});

test("topology reconciliation fails closed on duplicate persistent identity", () => {
  const previous = signedTopology({
    schemaVersion: 1 as const,
    entries: [{ stableSlideId: randomUUID(), slidePart: "ppt/slides/slide1.xml", position: 0, management: "managed" as const, presentationSlideId: 256, creationId: 1001 }],
    deletedStableSlideIds: [],
  });
  const inspected = { slides: [
    { position: 0, slidePart: "ppt/slides/slide1.xml", presentationSlideId: 256, relationshipId: "rId1", relationshipTarget: "slides/slide1.xml", creationId: 1001, xmlSha256: "b".repeat(64), relationshipsSha256: null },
    { position: 1, slidePart: "ppt/slides/slide2.xml", presentationSlideId: 300, relationshipId: "rId2", relationshipTarget: "slides/slide2.xml", creationId: 1001, xmlSha256: "c".repeat(64), relationshipsSha256: null },
  ] };

  const reconciled = reconcileSlideTopology(previous, inspected);
  assert.match(reconciled.conflicts.join("\n"), /duplicate|ambiguous/i);
});

test("topology reconciliation rejects a known presentation ID with an uncorroborated creation ID", () => {
  const previous = signedTopology({
    schemaVersion: 1 as const,
    entries: [{ stableSlideId: randomUUID(), slidePart: "ppt/slides/slide1.xml", position: 0, management: "managed" as const, presentationSlideId: 256, creationId: 1001 }],
    deletedStableSlideIds: [],
  });
  const reconciled = reconcileSlideTopology(previous, { slides: [{
    position: 0,
    slidePart: "ppt/slides/slide1.xml",
    presentationSlideId: 256,
    relationshipId: "rId1",
    relationshipTarget: "slides/slide1.xml",
    creationId: 9999,
    xmlSha256: "d".repeat(64),
    relationshipsSha256: null,
  }] });
  assert.match(reconciled.conflicts.join("\n"), /conflicting|corroborate|identity/i);
  assert.equal(reconciled.topology.entries[0]!.creationId, 1001);
});

test("topology carries strict deletion evidence while allowing a genuinely new unmanaged slide", () => {
  const deleted = randomUUID();
  const survivor = randomUUID();
  const first = signedTopology({
    schemaVersion: 1 as const,
    entries: [
      { stableSlideId: deleted, slidePart: "ppt/slides/slide1.xml", position: 0, management: "managed" as const, presentationSlideId: 256, creationId: 1001 },
      { stableSlideId: survivor, slidePart: "ppt/slides/slide2.xml", position: 1, management: "managed" as const, presentationSlideId: 257, creationId: 1002 },
    ],
    deletedStableSlideIds: [],
  });
  const onlySurvivor = { slides: [{ position: 0, slidePart: "ppt/slides/slide2.xml", presentationSlideId: 257, relationshipId: "rId2", relationshipTarget: "slides/slide2.xml", creationId: 1002, xmlSha256: "e".repeat(64), relationshipsSha256: null }] };
  const second = reconcileSlideTopology(first, onlySurvivor);
  assert.deepEqual(second.conflicts, []);
  assert.deepEqual(second.topology.deletedStableSlideIds, [deleted]);
  const third = reconcileSlideTopology(second.topology, onlySurvivor);
  assert.deepEqual(third.topology.deletedStableSlideIds, [deleted]);

  const inserted = reconcileSlideTopology(third.topology, { slides: [
    ...onlySurvivor.slides,
    { position: 1, slidePart: "ppt/slides/slide9.xml", presentationSlideId: 300, relationshipId: "rId9", relationshipTarget: "slides/slide9.xml", creationId: 2003, xmlSha256: "f".repeat(64), relationshipsSha256: null },
  ] });
  assert.deepEqual(inserted.conflicts, []);
  assert.equal(inserted.topology.entries[1]!.management, "unmanaged");
  assert.deepEqual(inserted.topology.deletedStableSlideIds, [deleted]);
  assert.deepEqual(inserted.topology.deletedSlideIdentities, [{ stableSlideId: deleted, presentationSlideId: 256, creationId: 1001 }]);

  const reappeared = reconcileSlideTopology(third.topology, { slides: [
    ...onlySurvivor.slides,
    { position: 1, slidePart: "ppt/slides/slide9.xml", presentationSlideId: 256, relationshipId: "rId9", relationshipTarget: "slides/slide9.xml", creationId: 1001, xmlSha256: "f".repeat(64), relationshipsSha256: null },
  ] });
  assert.match(reappeared.conflicts.join("\n"), /deleted|identity|unknown/i);
  assert.deepEqual(reappeared.topology, third.topology);
});

test("topology accumulates tombstones and rejects duplicate or inconsistent deletion evidence", () => {
  const first = randomUUID();
  const second = randomUUID();
  const initial = signedTopology({
    schemaVersion: 1 as const,
    entries: [
      { stableSlideId: first, slidePart: "ppt/slides/slide1.xml", position: 0, management: "managed" as const, presentationSlideId: 256, creationId: 1001 },
      { stableSlideId: second, slidePart: "ppt/slides/slide2.xml", position: 1, management: "managed" as const, presentationSlideId: 257, creationId: 1002 },
    ],
    deletedStableSlideIds: [],
    deletedSlideIdentities: [],
  });
  const afterFirst = reconcileSlideTopology(initial, { slides: [{ position: 0, slidePart: "ppt/slides/slide2.xml", presentationSlideId: 257, relationshipId: "rId2", relationshipTarget: "slides/slide2.xml", creationId: 1002, xmlSha256: "a".repeat(64), relationshipsSha256: null }] });
  const afterSecond = reconcileSlideTopology(afterFirst.topology, { slides: [] });
  assert.deepEqual(afterSecond.topology.deletedStableSlideIds, [first, second]);
  assert.deepEqual(afterSecond.topology.deletedSlideIdentities, [
    { stableSlideId: first, presentationSlideId: 256, creationId: 1001 },
    { stableSlideId: second, presentationSlideId: 257, creationId: 1002 },
  ]);
  const duplicate = {
    ...afterSecond.topology,
    deletedSlideIdentities: [...afterSecond.topology.deletedSlideIdentities, afterSecond.topology.deletedSlideIdentities[0]],
  };
  duplicate.sha256 = createHash("sha256").update(JSON.stringify({
    schemaVersion: duplicate.schemaVersion,
    entries: duplicate.entries,
    deletedStableSlideIds: duplicate.deletedStableSlideIds,
    deletedSlideIdentities: duplicate.deletedSlideIdentities,
  })).digest("hex");
  assert.equal(SlideTopologySchema.safeParse(duplicate).success, false);
});
