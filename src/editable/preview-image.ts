import sharp from "sharp";

export const EDITABLE_PREVIEW_WIDTH = 1920;
export const EDITABLE_PREVIEW_HEIGHT = 1080;

export async function assertCompleteEditablePreview(bytes: Buffer): Promise<void> {
  try {
    const metadata = await sharp(bytes, { failOn: "error" }).metadata();
    const decoded = await sharp(bytes, { failOn: "error" }).raw().toBuffer({ resolveWithObject: true });
    if (
      metadata.format !== "png"
      || decoded.info.width !== EDITABLE_PREVIEW_WIDTH
      || decoded.info.height !== EDITABLE_PREVIEW_HEIGHT
    ) throw new Error("preview geometry or format mismatch");
  } catch (error: unknown) {
    throw new Error("editable preview must be a complete 1920x1080 PNG", { cause: error });
  }
}
