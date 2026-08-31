import type { PreparedReviewRequiredObject } from "../editable/schemas.js";
import type { DeckEditSession, LocalDeckRevision } from "./schemas.js";

export function completeReviewRequiredObjects(
  parent: LocalDeckRevision,
  session: Pick<DeckEditSession, "targetSlideId" | "reviewRequiredObjects">,
): PreparedReviewRequiredObject[] {
  const bySlideId = { ...parent.reviewRequiredObjectsBySlideId };
  if (session.reviewRequiredObjects.length > 0 || !parent.editableSlideIds.includes(session.targetSlideId)) {
    bySlideId[session.targetSlideId] = session.reviewRequiredObjects;
  }
  const results: PreparedReviewRequiredObject[] = [];
  const identities = new Map<string, PreparedReviewRequiredObject>();
  for (const entry of [...parent.slideTopology.entries].sort((left, right) => left.position - right.position)) {
    for (const object of bySlideId[entry.stableSlideId] ?? []) {
      const prepared = { stableSlideId: entry.stableSlideId, ...object };
      const identity = `${prepared.stableSlideId}\u0000${prepared.elementId}`;
      const prior = identities.get(identity);
      if (prior) {
        if (JSON.stringify(prior) !== JSON.stringify(prepared)) {
          throw new Error("authenticated review-required metadata has a conflicting object identity");
        }
        continue;
      }
      identities.set(identity, prepared);
      results.push(prepared);
    }
  }
  return results;
}
