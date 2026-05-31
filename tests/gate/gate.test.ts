import { test, expect } from "bun:test"
import { computeGate } from "../../src/gate/gate"
import type { RuleResult } from "../../src/findings/types"

const clean = (id: string): RuleResult => ({ ruleId: id, status: "clean", findings: [] })
const errored = (id: string): RuleResult => ({ ruleId: id, status: "errored", findings: [], reason: "timeout" })
const violation = (id: string, sev: "error" | "warn"): RuleResult => ({
  ruleId: id, status: "violations",
  findings: [{ ruleId: id, layer: "L", file: "x", line: 1, severity: sev, explanation: "e", confidence: 1 }],
})

test("passes when all dispatched rules are clean", () => {
  const g = computeGate([clean("a"), clean("b")], ["a", "b"], false)
  expect(g.passed).toBe(true)
})

test("fails when any error-severity finding exists", () => {
  const g = computeGate([violation("a", "error")], ["a"], false)
  expect(g.passed).toBe(false)
  expect(g.errorFindings).toBe(1)
})

test("warn-only findings do not fail the gate", () => {
  const g = computeGate([violation("a", "warn")], ["a"], false)
  expect(g.passed).toBe(true)
})

test("fail-closed: a dispatched rule with no recorded result fails", () => {
  const g = computeGate([clean("a")], ["a", "b"], false)
  expect(g.passed).toBe(false)
  expect(g.unevaluatedRuleIds).toEqual(["b"])
})

test("fail-closed: an errored rule fails", () => {
  const g = computeGate([errored("a")], ["a"], false)
  expect(g.passed).toBe(false)
})

test("fail-open: errored/unevaluated rules do not fail", () => {
  const g = computeGate([errored("a")], ["a", "b"], true)
  expect(g.passed).toBe(true)
})
