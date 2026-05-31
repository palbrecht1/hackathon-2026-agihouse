import type { DispatchItem } from "../match/matcher"
import { buildOrchestratorPrompt, buildSubagentTaskPrompt } from "./prompt"

export interface PromptClient {
  createSession(): Promise<{ id: string }>
  prompt(sessionId: string, agent: string, text: string): Promise<{ text: string }>
}

export interface RunOptions {
  items: DispatchItem[]
  diffByFile: Record<string, string>
}

/**
 * Drives the orchestrator session. The orchestrator LLM does the fan-out via the
 * task tool and posting via the reporter tool; we just give it the dispatch list
 * plus, appended, each rule's ready-to-use subagent task prompt.
 */
export async function runOrchestrator(client: PromptClient, opts: RunOptions): Promise<void> {
  const session = await client.createSession()
  const taskPrompts = opts.items
    .map((i) => `=== task prompt for rule ${i.rule.id} ===\n${buildSubagentTaskPrompt(i, opts.diffByFile)}`)
    .join("\n\n")
  const prompt = `${buildOrchestratorPrompt(opts.items)}\n\n${taskPrompts}`
  await client.prompt(session.id, "orchestrator", prompt)
}
