import assert from "node:assert/strict";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import JSZip from "jszip";

import {
  loadBoundedPptxArchive,
  MAX_PPTX_ARCHIVE_BYTES,
  readBoundedPptxArchiveFile,
} from "../src/deck-revisions/archive.js";

test("loads ordinary PPTX archives within the expansion budget", async () => {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("ppt/presentation.xml", "<presentation/>");
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const loaded = await loadBoundedPptxArchive(bytes);
  assert.equal(await loaded.file("ppt/presentation.xml")!.async("string"), "<presentation/>");
});

test("rejects PPTX archives with extreme decompression amplification before member expansion", async () => {
  const zip = new JSZip();
  zip.file("ppt/slides/oversized.xml", "A".repeat(10 * 1024 * 1024));
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  assert.ok(bytes.length < 64 * 1024, "regression fixture must remain highly compressed");
  await assert.rejects(loadBoundedPptxArchive(bytes), /expansion|budget/i);
});

test("rejects executable and embedded active content in a PPTX package", async () => {
  for (const name of [
    "ppt/vbaProject.bin",
    "ppt/activeX/activeX1.bin",
    "ppt/embeddings/oleObject1.bin",
  ]) {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types/>");
    zip.file(name, "payload");
    const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    await assert.rejects(loadBoundedPptxArchive(bytes), /active content/i);
  }
});

test("rejects oversized sparse PPTX files before opening or allocating their contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "superppt-archive-limit-"));
  try {
    const path = join(root, "oversized.pptx");
    const handle = await open(path, "wx", 0o600);
    await handle.truncate(MAX_PPTX_ARCHIVE_BYTES + 1);
    await handle.close();
    let opened = false;
    await assert.rejects(
      readBoundedPptxArchiveFile(path, { afterOpen: () => { opened = true; } }),
      /regular file|size|budget/i,
    );
    assert.equal(opened, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
