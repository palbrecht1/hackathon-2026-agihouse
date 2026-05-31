import { z } from "zod"

export const SeveritySchema = z.enum(["error", "warn"])
export type Severity = z.infer<typeof SeveritySchema>

export const RuleSchema = z.object({
  id: z.string().min(1),
  glob: z.string().min(1),
  severity: SeveritySchema,
  rule: z.string().min(1),
  tools: z.array(z.string().min(1)).optional(),
})
export type RuleConfig = z.infer<typeof RuleSchema>

export const LayerFileSchema = z.object({
  layer: z.string().min(1),
  description: z.string().min(1),
  tools: z.array(z.string().min(1)).optional(),
  rules: z.array(RuleSchema).min(1),
})
export type LayerFile = z.infer<typeof LayerFileSchema>

/** A rule flattened with its layer's shared context — the atomic dispatch unit. */
export interface Rule {
  id: string
  layer: string
  layerDescription: string
  glob: string
  severity: Severity
  rule: string
  /** Custom reviewer tool names: union of the layer's and the rule's `tools`. */
  tools: string[]
}
