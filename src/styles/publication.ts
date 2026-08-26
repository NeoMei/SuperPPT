import sharp from "sharp";

import type { SlideSpec, StyleSelection } from "../planning/schemas.js";
import { loadBuiltInStyleCatalog } from "./catalog.js";

export async function validateStylePublication(
  specs: SlideSpec[],
  selection: StyleSelection,
  sample: Buffer,
): Promise<void> {
  const catalog = await loadBuiltInStyleCatalog();
  if (!catalog.styles.some(({ id }) => id === selection.styleId)) {
    throw new Error(`unknown built-in style: ${selection.styleId}`);
  }
  if (!specs.some(({ slideId }) => slideId === selection.representativeSlideId)) {
    throw new Error("representative slide must exist in current outline");
  }

  let format: string | undefined;
  let width: number | undefined;
  let height: number | undefined;
  try {
    const image = sharp(sample, { failOn: "error" });
    ({ format, width, height } = await image.metadata());
    await image.clone().raw().toBuffer();
  } catch (error: unknown) {
    throw new Error("style sample must be a decodable PNG", { cause: error });
  }
  if (format !== "png" || !width || !height) {
    throw new Error("style sample must be a decodable PNG");
  }
  if (width * 9 !== height * 16) {
    throw new Error("style sample must use a 16:9 composition");
  }
}
