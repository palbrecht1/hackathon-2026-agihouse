import { test, expect } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeLocalOutput } from "../../src/report/local"
import type { RuleResult } from "../../src/findings/types"

test("writes findings.json and summary.md under <epochMs>/", () => {
  const base = mkdtempSync(join(tmpdir(), "out-"))
  const results: RuleResult[] = [
    { ruleId: "r", status: "violations", findings: [
      { ruleId: "r", layer: "L", file: "a.ts", line: 3, severity: "warn", explanation: "x", confidence: 0.7 },
    ] },
  ]
  const dir = writeLocalOutput(results, base, 1733000000000)
  expect(dir).toBe(join(base, "1733000000000"))
  const findings = JSON.parse(readFileSync(join(dir, "findings.json"), "utf8"))
  expect(findings).toHaveLength(1)
  expect(findings[0].file).toBe("a.ts")
  expect(readFileSync(join(dir, "summary.md"), "utf8")).toContain("a.ts:3")
})
