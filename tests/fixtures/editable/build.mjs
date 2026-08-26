import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = new URL("./", import.meta.url);
await mkdir(new URL("assets/", root), { recursive: true });
await sharp({
  create: {
    width: 1280,
    height: 720,
    channels: 4,
    background: "#152131",
  },
}).png().toFile(fileURLToPath(new URL("clean-background.png", root)));
const icon = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><circle cx="60" cy="60" r="54" fill="#48C6D9"/><path d="M32 61h56M60 33v56" stroke="#10202E" stroke-width="10"/></svg>');
await sharp(icon).png().toFile(fileURLToPath(new URL("assets/icon.png", root)));
