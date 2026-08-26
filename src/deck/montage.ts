import sharp from "sharp";

import type { FinalRender } from "./assemble.js";

export async function buildMontage(renders: FinalRender[], output: string): Promise<void> {
  if (renders.length === 0) throw new Error("montage requires at least one render");
  const columns = Math.min(4, renders.length);
  const rows = Math.ceil(renders.length / columns);
  const width = 400;
  const height = 225;
  const tiles = await Promise.all(renders.map((render) =>
    sharp(render.bytes).resize(width, height, { fit: "fill" }).jpeg({ quality: 82 }).toBuffer()
  ));
  await sharp({
    create: {
      width: columns * width,
      height: rows * height,
      channels: 3,
      background: "#ececec",
    },
  }).composite(tiles.map((input, index) => ({
    input,
    left: index % columns * width,
    top: Math.floor(index / columns) * height,
  }))).jpeg({ quality: 88 }).toFile(output);
}
