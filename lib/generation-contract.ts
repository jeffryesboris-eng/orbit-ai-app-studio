import { z } from "zod";

export const MAX_PROMPT_LENGTH = 2_000;
export const MAX_CURRENT_HTML_LENGTH = 120_000;
export const MAX_GENERATED_HTML_LENGTH = 120_000;

export const generatedAppSchema = z.object({
  title: z.string().trim().min(1).max(80),
  summary: z.string().trim().min(1).max(240),
  html: z.string().trim().min(300).max(MAX_GENERATED_HTML_LENGTH),
});

export type GeneratedApp = z.infer<typeof generatedAppSchema>;

export const generationRequestSchema = z.object({
  prompt: z.string().trim().min(3).max(MAX_PROMPT_LENGTH),
  currentApp: generatedAppSchema.extend({
    html: z.string().trim().min(300).max(MAX_CURRENT_HTML_LENGTH),
  }).optional(),
}).strict();

export type GenerationRequest = z.infer<typeof generationRequestSchema>;

export type GenerationSuccess = {
  ok: true;
  data: GeneratedApp;
  meta: { mode: "create" | "refine"; model: string };
};

export type GenerationError = {
  ok: false;
  error: { code: string; message: string; retryable: boolean; retryAfter?: number };
};

export type GenerationResponse = GenerationSuccess | GenerationError;
