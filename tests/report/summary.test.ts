import { test, expect } from "bun:test"
import { renderSummaryMarkdown } from "../../src/report/summary"
import type { RuleResult } from "../../src/findings/types"

test("groups findings by layer and shows severity", () => {
  const results: RuleResult[] = [
    { ruleId: "no-db", status: "violations", findings: [
      { ruleId: "no-db", layer: "MVC", file: "src/services/u.ts", line: 12, severity: "error", explanation: "direct DB", confidence: 0.95 },
    ] },
    { ruleId: "ok", status: "clean", findings: [] },
  ]
  const md = renderSummaryMarkdown(results)
  expect(md).toContain("MVC")
  expect(md).toContain("src/services/u.ts:12")
  expect(md).toContain("direct DB")
})

test("renders a clean message when no findings", () => {
  expect(renderSummaryMarkdown([{ ruleId: "a", status: "clean", findings: [] }])).toContain("No violations")
})
