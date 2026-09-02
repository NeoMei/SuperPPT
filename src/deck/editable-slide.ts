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
