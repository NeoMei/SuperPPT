import { randomUUID } from "node:crypto";

import {
  AnchoredDirectory,
  type RevisionEvidenceOperations,
  withAnchoredDirectory,
} from "./anchored-fs.js";

type ProjectFile = { parent: AnchoredDirectory; name: string };

async function withProjectFileParents<T>(
  root: string,
  action: (file: (path: string) => ProjectFile) => Promise<T> | T,
): Promise<T> {
  return withAnchoredDirectory(root, async (project) => {
    const directories = new Map<string, AnchoredDirectory>([["", project]]);
    const opened: AnchoredDirectory[] = [];
    const file = (path: string): ProjectFile => {
      const parts = path.split("/");
      if (
        parts.length === 0
        || parts.some((part) => !part || part === "." || part === ".." || part.includes("\\"))
      ) throw new Error(`unsafe planning artifact path: ${path}`);
      const name = parts.pop()!;
      let key = "";
      let parent = project;
      for (const part of parts) {
        key = key ? `${key}/${part}` : part;
        let child = directories.get(key);
        if (!child) {
          child = parent.child(part, false);
          directories.set(key, child);
          opened.push(child);
        }
        parent = child;
      }
      return { parent, name };
    };
    try {
      return await action(file);
    } finally {
      for (const directory of opened.reverse()) directory.close();
    }
  });
}

export async function readProjectFileSet(
  root: string,
  paths: readonly string[],
): Promise<Map<string, Buffer | null>> {
  return withProjectFileParents(root, (file) => new Map(
    [...new Set(paths)].sort().map((path) => {
      const { parent, name } = file(path);
      return [path, parent.read(name)] as const;
    }),
  ));
}

export async function writeProjectFileSet(
  root: string,
  replacements: ReadonlyMap<string, Buffer | null>,
  operations?: RevisionEvidenceOperations,
): Promise<void> {
  await withProjectFileParents(root, async (file) => {
    let index = 0;
    for (const [path, value] of [...replacements.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      await operations?.beforePlanningArtifactWrite?.(path, index);
      const { parent, name } = file(path);
      const current = parent.read(name);
      if (value === null) {
        if (current !== null) parent.remove(name);
      } else if (!current?.equals(value)) {
        parent.replace(name, value, `.${name}.${randomUUID()}.rollback`);
      }
      await operations?.afterPlanningArtifactRestored?.(path);
      index += 1;
    }
  });
}
