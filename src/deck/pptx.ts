import type { PreparedEditableSlide } from "./editable-slide.js";
import { writePresentation } from "./presentation-service.js";

type PptxPageBase = {
  id: string;
  bytes: Buffer;
  contentType: "image/png" | "image/jpeg";
};

export type PptxImagePage = PptxPageBase & { mode?: "image" };

export type PptxEditablePage = PptxPageBase & {
  mode: "editable";
  editable: PreparedEditableSlide;
};

export type PptxPage = PptxImagePage | PptxEditablePage;

export async function createPresentation(
  pages: PptxPage[],
  output: string,
  trustedRoot?: string,
): Promise<void> {
  return writePresentation(pages, output, trustedRoot);
}
