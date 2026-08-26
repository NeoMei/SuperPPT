import { writeFile } from "node:fs/promises";

import { PDFDocument } from "pdf-lib";

import { PDF_HEIGHT_POINTS, PDF_WIDTH_POINTS } from "./geometry.js";
import type { FinalRender } from "./assemble.js";

export async function buildPdfBytes(renders: FinalRender[]): Promise<Buffer> {
  if (renders.length === 0) throw new Error("PDF requires at least one render");
  const document = await PDFDocument.create();
  const fixedDate = new Date("2000-01-01T00:00:00.000Z");
  document.setCreationDate(fixedDate);
  document.setModificationDate(fixedDate);
  document.setProducer("SuperPPT");
  document.setCreator("SuperPPT");
  for (const render of renders) {
    const embedded = render.contentType === "image/png"
      ? await document.embedPng(render.bytes)
      : await document.embedJpg(render.bytes);
    const page = document.addPage([PDF_WIDTH_POINTS, PDF_HEIGHT_POINTS]);
    page.drawImage(embedded, {
      x: 0,
      y: 0,
      width: PDF_WIDTH_POINTS,
      height: PDF_HEIGHT_POINTS,
    });
  }
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

export async function exportPdf(renders: FinalRender[], output: string): Promise<void> {
  await writeFile(output, await buildPdfBytes(renders), { flag: "wx" });
}
