import type { Severity } from "../config/schema"

export interface Finding {
  ruleId: string
  layer: string
  file: string
  line: number
  severity: Severity
  explanation: string
  confidence: number // 0..1
  suggestedFix?: string
}

export type RuleStatus = "clean" | "violations" | "errored"

/** One per dispatched rule — what the orchestrator recorded via the reporter tool. */
export interface RuleResult {
  ruleId: string
  status: RuleStatus
  findings: Finding[]
  reason?: string // populated when status === "errored"
}
