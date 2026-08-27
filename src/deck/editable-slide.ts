import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { readRegularFileNoFollow } from "../project/safe-file.js";
import { EditableManifestSchema, type EditableManifest } from "../editable/schemas.js";

export type EditablePage = {
  id: string;
  order: number;
  mode: "editable";
  render: string;
  expectedSha256?: string;
  editableRoot: string;
  manifest: EditableManifest;
  modifiedRevisionId?: string;
  expectedModifiedRevisionRecordSha256?: string;
};

export type PreparedEditableElement =
  | Extract<EditableManifest["elements"][number], { kind: "text" }>
  | (Extract<EditableManifest["elements"][number], { kind: "asset" }> & { bytes: Buffer });

export type PreparedEditableSlide = {
  id: string;
  cleanBackground: Buffer;
  elements: PreparedEditableElement[];
};

async function ownedFile(root: string, projectPath: string): Promise<Buffer> {
  const path = resolve(root, ...projectPath.split("/"));
  const difference = relative(root, path);
  if (!difference || difference.startsWith("..") || isAbsolute(difference)) throw new Error("editable slide asset escaped its root");
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("editable slide asset must be a regular file");
  const canonical = await realpath(path);
  const canonicalDifference = relative(root, canonical);
  if (canonicalDifference.startsWith("..") || isAbsolute(canonicalDifference)) throw new Error("editable slide asset escaped its root");
  return readRegularFileNoFollow(path);
}

export async function prepareEditableSlide(page: EditablePage): Promise<PreparedEditableSlide> {
  const root = resolve(page.editableRoot);
  const info = await lstat(root);
  if (info.isSymbolicLink() || !info.isDirectory() || await realpath(root) !== root) {
    throw new Error("editable slide root must be canonical and regular");
  }
  const manifest = EditableManifestSchema.parse(page.manifest);
  return {
    id: page.id,
    cleanBackground: await ownedFile(root, "clean-background.png"),
    elements: await Promise.all([...manifest.elements]
      .sort((left, right) => left.zIndex - right.zIndex || left.id.localeCompare(right.id))
      .map(async (element): Promise<PreparedEditableElement> => element.kind === "asset"
        ? { ...element, bytes: await ownedFile(root, element.assetPath) }
        : element)),
  };
}

export function addEditableSlide(slide: any, page: PreparedEditableSlide): void {
  const background = slide.images.add({
    name: `background-${page.id}`,
    blob: page.cleanBackground,
    contentType: "image/png",
    alt: `Clean background for ${page.id}`,
    fit: "fill",
    position: { left: 0, top: 0, width: 1280, height: 720 },
  });
  background.name = `background-${page.id}`;
  for (const element of page.elements) {
    if (element.kind === "text") {
      const shape = slide.shapes.add({
        geometry: "textbox",
        name: `text-${element.id}`,
        position: { left: element.bbox.x, top: element.bbox.y, width: element.bbox.width, height: element.bbox.height, rotation: element.rotation },
        fill: "none",
        line: { style: "solid", fill: "none", width: 0 },
      });
      shape.name = `text-${element.id}`;
      shape.text = element.text;
      shape.text.style = {
        fontFamily: "Microsoft YaHei",
        fontSize: element.fontSizePx,
        color: element.color.startsWith("#") ? element.color : `#${element.color}`,
        bold: element.bold ?? false,
        alignment: element.align,
        characterSpacing: element.charSpacingPx ?? 0,
      };
    } else {
      const image = slide.images.add({
        name: `asset-${element.id}`,
        blob: element.bytes,
        contentType: "image/png",
        alt: element.label,
        fit: "fill",
        position: { left: element.bbox.x, top: element.bbox.y, width: element.bbox.width, height: element.bbox.height },
      });
      image.name = `asset-${element.id}`;
    }
  }
}
