import { z } from "zod";

import { Sha256Schema } from "../project/schemas.js";

export const FileEvidenceSchema = z.object({
  path: z.string().min(1),
  sha256: Sha256Schema,
}).strict();

export const ClientAcceptanceSchema = z.object({
  application: z.enum(["WPS", "PowerPoint"]).nullable(),
  opened: z.boolean(),
  edited: z.boolean(),
  saved: z.boolean(),
  reopened: z.boolean(),
  confirmedAt: z.string().datetime().nullable(),
}).strict();

export const AcceptanceSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: z.string().uuid(),
  revisionId: z.string().uuid(),
  slides: z.array(z.object({
    id: z.string().uuid(),
    order: z.number().int().nonnegative(),
    mode: z.enum(["image", "editable"]),
    finalRenderSha256: Sha256Schema,
  }).strict()).min(1),
  exports: z.object({
    pptx: FileEvidenceSchema,
    pdf: FileEvidenceSchema,
    montage: FileEvidenceSchema,
  }).strict(),
  gates: z.object({
    outline: z.string().uuid(),
    slideSpecs: z.string().uuid(),
    styleSample: z.string().uuid(),
  }).strict(),
  providerId: z.string().min(1),
  editablePageIds: z.array(z.string().uuid()),
  warnings: z.array(z.string().min(1)),
  deliveryComplete: z.boolean(),
  clientAcceptance: ClientAcceptanceSchema,
}).strict().superRefine((value, context) => {
  const editablePageIds = value.slides
    .filter((slide) => slide.mode === "editable")
    .map((slide) => slide.id);
  if (JSON.stringify(value.editablePageIds) !== JSON.stringify(editablePageIds)) {
    context.addIssue({
      code: "custom",
      path: ["editablePageIds"],
      message: "editablePageIds must exactly match editable slides",
    });
  }
  const complete = value.clientAcceptance.application !== null
    && value.clientAcceptance.opened
    && value.clientAcceptance.edited
    && value.clientAcceptance.saved
    && value.clientAcceptance.reopened
    && value.clientAcceptance.confirmedAt !== null;
  if (value.deliveryComplete !== complete) {
    context.addIssue({
      code: "custom",
      path: ["deliveryComplete"],
      message: "deliveryComplete must exactly match explicit client acceptance",
    });
  }
});

export type Acceptance = z.infer<typeof AcceptanceSchema>;
export type ClientAcceptance = z.infer<typeof ClientAcceptanceSchema>;
