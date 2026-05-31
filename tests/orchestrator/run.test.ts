import { test, expect } from "bun:test"
import { runOrchestrator, type PromptClient } from "../../src/orchestrator/run"
import type { DispatchItem } from "../../src/match/matcher"

const item: DispatchItem = {
  rule: { id: "r", layer: "L", layerDescription: "d", glob: "**", severity: "warn", rule: "x", tools: [] },
  matchedFiles: ["a.ts"],
}

test("creates a session and prompts the orchestrator agent with the dispatch list", async () => {
  const calls: { agent?: string; text: string }[] = []
  const client: PromptClient = {
    createSession: async () => ({ id: "s1" }),
    prompt: async (sessionId, agent, text) => { calls.push({ agent, text }); return { text: "done" } },
  }
  await runOrchestrator(client, { items: item ? [item] : [], diffByFile: { "a.ts": "@@" } })
  expect(calls).toHaveLength(1)
  expect(calls[0]!.agent).toBe("orchestrator")
  expect(calls[0]!.text).toContain("r")
})
