import { applyCompleteDeckReviewAction } from "../../src/project/promotion.js";
import { readCurrentDeckPointer } from "../../src/deck-revisions/store.js";

export async function authorizeCompleteDeckEdit(root: string, slideId: string): Promise<void> {
  const current = await readCurrentDeckPointer(root);
  await applyCompleteDeckReviewAction(root, {
    action: "edit-page",
    revisionId: current.revisionId,
    deckSha256: current.sha256,
    slideId,
  });
}
