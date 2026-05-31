import { test, expect } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendResult, readResults } from "../../src/findings/store"
import type { RuleResult } from "../../src/findings/types"

const path = () => join(mkdtempSync(join(tmpdir(), "store-")), "results.jsonl")

test("appends and reads results round-trip", () => {
  const p = path()
  const a: RuleResult = { ruleId: "a", status: "clean", findings: [] }
  const b: RuleResult = { ruleId: "b", status: "violations", findings: [
    { ruleId: "b", layer: "L", file: "x.ts", line: 1, severity: "error", explanation: "bad", confidence: 0.9 },
  ] }
  appendResult(p, a)
  appendResult(p, b)
  const all = readResults(p)
  expect(all.map((r) => r.ruleId)).toEqual(["a", "b"])
  expect(all[1]!.findings[0]!.severity).toBe("error")
})

test("readResults on missing file returns empty", () => {
  expect(readResults(path())).toEqual([])
})

test("appendResult creates the parent directory if it does not exist", () => {
  // The reporter tool is the first writer and the .review-output dir may not exist yet.
  const dir = mkdtempSync(join(tmpdir(), "store-"))
  const p = join(dir, "nested", "deeper", "results.jsonl")
  appendResult(p, { ruleId: "a", status: "clean", findings: [] })
  expect(readResults(p).map((r) => r.ruleId)).toEqual(["a"])
})
