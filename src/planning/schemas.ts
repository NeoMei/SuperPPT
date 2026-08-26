import { z } from "zod";

export const RoleSchema = z.enum([
  "cover",
  "section",
  "content",
  "process",
  "comparison",
  "data",
  "summary",
]);

export const BriefSchema = z.object({
  schemaVersion: z.literal(1),
  title: z.string().min(1),
  purpose: z.string().min(1),
  audience: z.string().min(1),
  language: z.string().min(1),
  targetSlides: z.number().int().min(3).max(60),
  mustCover: z.array(z.string().min(1)).min(1),
  constraints: z.array(z.string().min(1)),
}).strict();

const OutlineSlideSchema = z.object({
  id: z.string().uuid(),
  order: z.number().int().nonnegative(),
  title: z.string().min(1),
  role: RoleSchema,
  purpose: z.string().min(1),
  sourceRefs: z.array(z.string().min(1)).min(1),
}).strict();

export const OutlineSchema = z.object({
  schemaVersion: z.literal(1),
  slides: z.array(OutlineSlideSchema).min(3).max(60),
}).strict().superRefine((value, context) => {
  const ids = value.slides.map((slide) => slide.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({
      code: "custom",
      message: "stable slide IDs must be unique",
      path: ["slides"],
    });
  }
  const orders = value.slides.map((slide) => slide.order).sort((a, b) => a - b);
  if (orders.some((order, index) => order !== index)) {
    context.addIssue({
      code: "custom",
      message: "slide order must be contiguous from zero",
      path: ["slides"],
    });
  }
});

export const SlideSpecSchema = z.object({
  schemaVersion: z.literal(1),
  slideId: z.string().uuid(),
  title: z.string().min(1),
  role: RoleSchema,
  coreMessage: z.string().min(1),
  requiredText: z.array(z.string().min(1)).max(12),
  visualSubject: z.string().min(1),
  composition: z.string().min(1),
  relationships: z.array(z.string().min(1)),
  forbidden: z.array(z.string().min(1)),
  sourceRefs: z.array(z.string().min(1)).min(1),
}).strict();

export type Brief = z.infer<typeof BriefSchema>;
export type Outline = z.infer<typeof OutlineSchema>;
export type SlideSpec = z.infer<typeof SlideSpecSchema>;
