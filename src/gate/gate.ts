import type { RuleResult } from "../findings/types"

export interface GateResult {
  passed: boolean
  errorFindings: number
  erroredRuleIds: string[]
  unevaluatedRuleIds: string[]
}

/**
 * The merge gate. Deterministic and independent of the model: even if the
 * orchestrator silently dropped a dispatched rule, that rule is "unevaluated"
 * and fails closed by default.
 */
export function computeGate(
  results: RuleResult[],
  dispatchedRuleIds: string[],
  failOpen: boolean,
): GateResult {
  const byId = new Map(results.map((r) => [r.ruleId, r]))

  const errorFindings = results
    .flatMap((r) => r.findings)
    .filter((f) => f.severity === "error").length

  const erroredRuleIds = results.filter((r) => r.status === "errored").map((r) => r.ruleId)
  const unevaluatedRuleIds = dispatchedRuleIds.filter((id) => !byId.has(id))

  const blockedByErrors = errorFindings > 0
  const blockedByMissing = !failOpen && (erroredRuleIds.length > 0 || unevaluatedRuleIds.length > 0)

  return {
    passed: !blockedByErrors && !blockedByMissing,
    errorFindings,
    erroredRuleIds,
    unevaluatedRuleIds,
  }
}
