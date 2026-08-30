import { createHash, randomUUID } from "node:crypto";

import type { InspectedLocalPptx, InspectedSlidePart } from "./inspect.js";
import { SlideTopologySchema, type SlideTopology, type SlideTopologyEntry } from "./schemas.js";

export type ReconciledSlideTopology = {
  topology: SlideTopology;
  movements: Array<{ stableSlideId: string; from: number; to: number }>;
  conflicts: string[];
};

type InspectionShape = Pick<InspectedLocalPptx, "slides"> | { slides: InspectedSlidePart[] };

function topologyHash(value: Omit<SlideTopology, "sha256">): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function finalizeSlideTopology(
  entries: SlideTopologyEntry[],
  deletedStableSlideIds: string[],
): SlideTopology {
  const value = { schemaVersion: 1 as const, entries, deletedStableSlideIds };
  return SlideTopologySchema.parse({ ...value, sha256: topologyHash(value) });
}

export function reconcileSlideTopology(
  previous: SlideTopology,
  inspected: InspectionShape,
): ReconciledSlideTopology {
  const validPrevious = SlideTopologySchema.parse(previous);
  const conflicts: string[] = [];
  const creationCounts = new Map<number, number>();
  const presentationCounts = new Map<number, number>();
  for (const slide of inspected.slides) {
    if (slide.creationId !== null) creationCounts.set(slide.creationId, (creationCounts.get(slide.creationId) ?? 0) + 1);
    presentationCounts.set(slide.presentationSlideId, (presentationCounts.get(slide.presentationSlideId) ?? 0) + 1);
  }
  for (const [identity, count] of creationCounts) {
    if (count > 1) conflicts.push(`duplicate or ambiguous creation identity ${identity}`);
  }
  for (const [identity, count] of presentationCounts) {
    if (count > 1) conflicts.push(`duplicate or ambiguous presentation identity ${identity}`);
  }
  const byCreation = new Map(validPrevious.entries.map((entry) => [entry.creationId, entry]));
  const byPresentation = new Map(validPrevious.entries.map((entry) => [entry.presentationSlideId, entry]));
  const consumed = new Set<string>();
  const reservedStableIds = new Set([
    ...validPrevious.entries.map((entry) => entry.stableSlideId),
    ...validPrevious.deletedStableSlideIds,
  ]);
  const movements: ReconciledSlideTopology["movements"] = [];
  const entries: SlideTopologyEntry[] = inspected.slides.map((slide) => {
    const creationMatch = slide.creationId === null ? undefined : byCreation.get(slide.creationId);
    const presentationMatch = byPresentation.get(slide.presentationSlideId);
    if (
      (creationMatch || presentationMatch)
      && (!creationMatch || !presentationMatch || creationMatch.stableSlideId !== presentationMatch.stableSlideId)
    ) {
      conflicts.push(`conflicting identity evidence for ${slide.slidePart}`);
    }
    const known = creationMatch && presentationMatch && creationMatch.stableSlideId === presentationMatch.stableSlideId
      ? creationMatch
      : undefined;
    if (known) {
      if (consumed.has(known.stableSlideId)) conflicts.push(`one stable identity maps to multiple slides: ${known.stableSlideId}`);
      consumed.add(known.stableSlideId);
      if (known.position !== slide.position) movements.push({ stableSlideId: known.stableSlideId, from: known.position, to: slide.position });
      return {
        ...known,
        slidePart: slide.slidePart,
        position: slide.position,
        presentationSlideId: slide.presentationSlideId,
        creationId: slide.creationId ?? known.creationId,
      };
    }
    if (slide.creationId === null) conflicts.push(`new slide ${slide.slidePart} has no persistent creation identity`);
    if (validPrevious.deletedStableSlideIds.length > 0) {
      conflicts.push(`unknown slide identity ${slide.slidePart} cannot be distinguished from a deleted identity`);
    }
    let stableSlideId = randomUUID();
    while (reservedStableIds.has(stableSlideId)) stableSlideId = randomUUID();
    reservedStableIds.add(stableSlideId);
    return {
      stableSlideId,
      slidePart: slide.slidePart,
      position: slide.position,
      management: "unmanaged" as const,
      presentationSlideId: slide.presentationSlideId,
      creationId: slide.creationId ?? 1,
    };
  });
  const deletedStableSlideIds = [...new Set([
    ...validPrevious.deletedStableSlideIds,
    ...validPrevious.entries
      .filter((entry) => !consumed.has(entry.stableSlideId))
      .map((entry) => entry.stableSlideId),
  ])];
  if (conflicts.length > 0) {
    return { topology: validPrevious, movements: [], conflicts };
  }
  return { topology: finalizeSlideTopology(entries, deletedStableSlideIds), movements, conflicts };
}
