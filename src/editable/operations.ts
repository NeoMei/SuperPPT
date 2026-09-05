import { z } from "zod";
import { EditableBBoxSchema } from "./schemas.js";
export const EditOperationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("replace-text"), elementId: z.string().min(1), text: z.string() }).strict(),
  z.object({
    kind: z.literal("set-text-style"),
    elementId: z.string().min(1),
    color: z.string().optional(),
    fontSizePx: z.number().finite().positive().optional(),
    bold: z.boolean().optional(),
    align: z.enum(["left", "center", "right"]).optional(),
  }).strict().refine(
    (operation) => operation.color !== undefined
      || operation.fontSizePx !== undefined
      || operation.bold !== undefined
      || operation.align !== undefined,
    "set-text-style requires at least one style value",
  ),
  z.object({ kind: z.literal("move-asset"), elementId: z.string().min(1), bbox: EditableBBoxSchema }).strict(),
  z.object({ kind: z.literal("replace-asset"), elementId: z.string().min(1), assetPath: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("move-shape"), elementId: z.string().min(1), bbox: EditableBBoxSchema }).strict(),
  z.object({
    kind: z.literal("set-shape-style"),
    elementId: z.string().min(1),
    fillColor: z.string().optional(),
    strokeColor: z.string().optional(),
    strokeWidthPx: z.number().finite().nonnegative().optional(),
  }).strict().refine(
    (operation) => operation.fillColor !== undefined
      || operation.strokeColor !== undefined
      || operation.strokeWidthPx !== undefined,
    "set-shape-style requires at least one style value",
  ),
]);

export type EditOperation = z.infer<typeof EditOperationSchema>;
