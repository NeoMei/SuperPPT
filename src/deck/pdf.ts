import { writeFile } from "node:fs/promises";

import { PDFDocument } from "pdf-lib";

import { PDF_HEIGHT_POINTS, PDF_WIDTH_POINTS } from "./geometry.js";
import type { FinalRender } from "./assemble.js";

export async function exportPdf(renders: FinalRender[], output: string): Promise<void> {
  if (renders.length === 0) throw new Error("PDF requires at least one render");
  const document = await PDFDocument.create();
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
  await writeFile(output, await document.save(), { flag: "wx" });
}
