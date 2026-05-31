import { test, expect } from "bun:test"
import { buildAgentConfig } from "../../src/opencode/agents"
import { REPORTER_TOOL, REVIEWER_AGENT } from "../../src/orchestrator/prompt"
import type { Rule } from "../../src/config/schema"

const rule = (id: string, tools: string[]): Rule => ({
  id, glob: "*", layer: "L", layerDescription: "d", severity: "warn", rule: "r", tools,
})

test("orchestrator may report; generic subagent is denied the reporter tool and edits", () => {
  const cfg = buildAgentConfig("anthropic/claude-sonnet-4-5", [rule("a", [])])
  const orch = cfg.agent.orchestrator
  const rev = cfg.agent[REVIEWER_AGENT]!
  expect(orch.mode).toBe("primary")
  expect(orch.permission[REPORTER_TOOL]).toBe("allow")
  expect(orch.permission.task).toBe("allow")
  expect(rev.mode).toBe("subagent")
  expect(rev.permission[REPORTER_TOOL]).toBe("deny")
  expect(rev.permission.edit).toBe("deny")
  expect(rev.permission.bash).toBe("deny")
})

test("a custom-tooled rule gets a specialized subagent granting exactly its tools, reporter still denied", () => {
  const cfg = buildAgentConfig("anthropic/claude-sonnet-4-5", [rule("query-explain", ["sql_explain"])])
  const spec = cfg.agent["rule-reviewer-query-explain"]!
  expect(spec.mode).toBe("subagent")
  expect(spec.permission["sql_explain"]).toBe("allow")
  expect(spec.permission[REPORTER_TOOL]).toBe("deny")
  expect(spec.permission.edit).toBe("deny")
})
