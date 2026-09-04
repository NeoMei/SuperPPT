import sharp from "sharp";

import type { SlideSpec } from "../planning/schemas.js";
import { resolveStyleRecipe } from "./catalog.js";
import { lockSelection, MAX_STYLE_SAMPLE_BYTES, representativeSlideId } from "./sample-contract.js";
import { StyleSampleSelectionSchema, type StyleSampleSelection } from "./schemas.js";

export async function validateStylePublication(
  specs: SlideSpec[],
  selection: StyleSampleSelection,
  sample: Buffer,
): Promise<void> {
  StyleSampleSelectionSchema.parse(selection);
  await resolveStyleRecipe(lockSelection(selection));
  if (!specs.some(({ slideId }) => slideId === representativeSlideId(selection))) {
    throw new Error("representative slide must exist in current outline");
  }
  if (sample.length <= 0 || sample.length > MAX_STYLE_SAMPLE_BYTES) {
    throw new Error("style sample exceeds its size limit");
  }

  let format: string | undefined;
  let width: number | undefined;
  let height: number | undefined;
  try {
    const image = sharp(sample, { failOn: "error", limitInputPixels: 1920 * 1080, animated: false });
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
