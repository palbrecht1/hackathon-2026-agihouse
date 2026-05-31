import { test, expect } from "bun:test"
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runReview } from "../../src/orchestrator/harness"
import { loadRules } from "../../src/config/loader"
import { appendResult } from "../../src/findings/store"
import type { PromptClient } from "../../src/orchestrator/run"
import type { Source } from "../../src/source/types"

function rulesFrom(name: string, body: string) {
  const reviews = join(mkdtempSync(join(tmpdir(), "rev-")), ".reviews")
  mkdirSync(reviews)
  writeFileSync(join(reviews, name), body)
  return loadRules(reviews)
}

test("full path: match → orchestrate → gate fails on an error finding", async () => {
  const rules = rulesFrom("mvc.yaml",
    `layer: MVC\ndescription: services never touch DB\nrules:\n  - id: no-db\n    glob: "src/services/**"\n    severity: error\n    rule: flag direct DB access\n`)

  const storePath = join(mkdtempSync(join(tmpdir(), "store-")), "results.jsonl")
  const source: Source = { read: async () => ({ diffByFile: { "src/services/u.ts": "@@ +db.query()" } }) }

  // Fake orchestrator: writes the result the real LLM+tool would write.
  const client: PromptClient = {
    createSession: async () => ({ id: "s" }),
    prompt: async () => {
      appendResult(storePath, { ruleId: "no-db", status: "violations", findings: [
        { ruleId: "no-db", layer: "MVC", file: "src/services/u.ts", line: 1, severity: "error", explanation: "direct DB", confidence: 0.95 },
      ] })
      return { text: "done" }
    },
  }

  const gate = await runReview({ rules, source, client, storePath, failOpen: false })
  expect(gate.passed).toBe(false)
  expect(gate.errorFindings).toBe(1)
})

test("gate fails closed when orchestrator records nothing for a dispatched rule", async () => {
  const rules = rulesFrom("g.yaml",
    `layer: G\ndescription: d\nrules:\n  - id: g\n    glob: "**/*.ts"\n    severity: warn\n    rule: x\n`)
  const storePath = join(mkdtempSync(join(tmpdir(), "store-")), "results.jsonl")
  const source: Source = { read: async () => ({ diffByFile: { "a.ts": "@@" } }) }
  const client: PromptClient = { createSession: async () => ({ id: "s" }), prompt: async () => ({ text: "done" }) }

  const gate = await runReview({ rules, source, client, storePath, failOpen: false })
  expect(gate.passed).toBe(false)
  expect(gate.unevaluatedRuleIds).toEqual(["g"])
})
