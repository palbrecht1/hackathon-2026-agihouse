import { test, expect } from "bun:test"
import { buildOrchestratorPrompt, buildSubagentTaskPrompt } from "../../src/orchestrator/prompt"
import type { DispatchItem } from "../../src/match/matcher"
import { reviewerAgentFor } from "../../src/orchestrator/prompt"

const item: DispatchItem = {
  rule: { id: "no-db", layer: "MVC", layerDescription: "services never touch DB", glob: "src/services/**", severity: "error", rule: "flag direct DB access", tools: [] },
  matchedFiles: ["src/services/u.ts"],
}

const sqlItem: DispatchItem = {
  rule: { id: "query-explain", layer: "SQL", layerDescription: "queries must be efficient", glob: "**/*.sql.ts", severity: "error", rule: "run sql_explain", tools: ["sql_explain"] },
  matchedFiles: ["src/q.sql.ts"],
}

test("orchestrator prompt lists every rule id and instructs one report per rule", () => {
  const p = buildOrchestratorPrompt([item])
  expect(p).toContain("no-db")
  expect(p).toContain("rule-reviewer")
  expect(p).toContain("report") // the reporter tool name
  expect(p).toContain("exactly once") // one report call per rule
})

test("orchestrator prompt names the specialized subagent for a custom-tooled rule", () => {
  const p = buildOrchestratorPrompt([sqlItem])
  expect(p).toContain("rule-reviewer-query-explain")
})

test("reviewerAgentFor picks generic vs specialized by tools", () => {
  expect(reviewerAgentFor(item.rule)).toBe("rule-reviewer")
  expect(reviewerAgentFor(sqlItem.rule)).toBe("rule-reviewer-query-explain")
})

test("subagent task prompt includes rule prose, layer context, files, the diff, and tools", () => {
  const p = buildSubagentTaskPrompt(sqlItem, { "src/q.sql.ts": "@@ +SELECT *" })
  expect(p).toContain("queries must be efficient")
  expect(p).toContain("run sql_explain")
  expect(p).toContain("src/q.sql.ts")
  expect(p).toContain("SELECT *")
  expect(p).toContain("sql_explain") // available tools surfaced to the subagent
})
