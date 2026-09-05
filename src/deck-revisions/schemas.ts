import { createHash } from "node:crypto";

import { z } from "zod";



const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const SlideTopologyEntrySchema = z.object({
  stableSlideId: z.string().uuid(),
  slidePart: z.string().regex(/^ppt\/slides\/slide[0-9]+\.xml$/),
  position: z.number().int().nonnegative(),
  management: z.enum(["managed", "unmanaged"]),
  presentationSlideId: z.number().int().min(256).max(4294967295),
  creationId: z.number().int().positive().max(4294967295).nullable(),
}).strict();

export const DeletedSlideIdentitySchema = z.object({
  stableSlideId: z.string().uuid(),
  presentationSlideId: z.number().int().min(256).max(4294967295),
  creationId: z.number().int().positive().max(4294967295).nullable(),
}).strict();

export const SlideTopologySchema = z.object({
  schemaVersion: z.literal(1),
  entries: z.array(SlideTopologyEntrySchema),
  deletedStableSlideIds: z.array(z.string().uuid()),
  deletedSlideIdentities: z.array(DeletedSlideIdentitySchema),
  sha256: Sha256Schema,
}).strict().superRefine((topology, context) => {
  for (const [field, values] of [
    ["stableSlideId", topology.entries.map((entry) => entry.stableSlideId)],
    ["position", topology.entries.map((entry) => entry.position)],
    ["presentationSlideId", topology.entries.map((entry) => entry.presentationSlideId)],
  ] as const) {
    if (new Set<unknown>(values).size !== values.length) {
      context.addIssue({ code: "custom", path: ["entries"], message: `slide topology ${field} values must be unique` });
    }
  }
  const activeCreationIds = topology.entries.flatMap((entry) => entry.creationId === null ? [] : [entry.creationId]);
  if (new Set(activeCreationIds).size !== activeCreationIds.length) {
    context.addIssue({ code: "custom", path: ["entries"], message: "slide topology creationId values must be unique when present" });
  }
  if (topology.deletedStableSlideIds.some((id) => topology.entries.some((entry) => entry.stableSlideId === id))) {
    context.addIssue({ code: "custom", path: ["deletedStableSlideIds"], message: "active slide identities cannot also be deleted" });
  }
  for (const [field, values] of [
    ["stableSlideId", topology.deletedSlideIdentities.map((entry) => entry.stableSlideId)],
    ["presentationSlideId", topology.deletedSlideIdentities.map((entry) => entry.presentationSlideId)],
  ] as const) {
    if (new Set<unknown>(values).size !== values.length) {
      context.addIssue({ code: "custom", path: ["deletedSlideIdentities"], message: `deleted slide ${field} values must be unique` });
    }
  }
  const deletedCreationIds = topology.deletedSlideIdentities.flatMap((entry) => entry.creationId === null ? [] : [entry.creationId]);
  if (new Set(deletedCreationIds).size !== deletedCreationIds.length) {
    context.addIssue({ code: "custom", path: ["deletedSlideIdentities"], message: "deleted slide creationId values must be unique when present" });
  }
  if (JSON.stringify(topology.deletedStableSlideIds) !== JSON.stringify(topology.deletedSlideIdentities.map((entry) => entry.stableSlideId))) {
    context.addIssue({ code: "custom", path: ["deletedStableSlideIds"], message: "deleted stable IDs must exactly match tombstone evidence" });
  }
  if (topology.deletedSlideIdentities.some((deleted) => topology.entries.some((active) =>
    active.stableSlideId === deleted.stableSlideId
    || active.presentationSlideId === deleted.presentationSlideId
    || (active.creationId !== null && deleted.creationId !== null && active.creationId === deleted.creationId)))) {
    context.addIssue({ code: "custom", path: ["deletedSlideIdentities"], message: "active and deleted slide evidence must be disjoint" });
  }
  const expected = createHash("sha256").update(JSON.stringify({
    schemaVersion: topology.schemaVersion,
    entries: topology.entries,
    deletedStableSlideIds: topology.deletedStableSlideIds,
    deletedSlideIdentities: topology.deletedSlideIdentities,
  })).digest("hex");
  if (topology.sha256 !== expected) {
    context.addIssue({ code: "custom", path: ["sha256"], message: "slide topology hash does not match its exact content" });
  }
});


export type SlideTopology = z.infer<typeof SlideTopologySchema>;
export type SlideTopologyEntry = z.infer<typeof SlideTopologyEntrySchema>;
export type DeletedSlideIdentity = z.infer<typeof DeletedSlideIdentitySchema>;
