import { appendFileSync, existsSync, readFileSync } from "node:fs"
import type { RuleResult } from "./types"

/**
 * The result store is a JSONL file so it survives the process boundary between
 * our harness and the OpenCode server that runs the reporter tool. One line per
 * dispatched rule.
 */
export function appendResult(storePath: string, result: RuleResult): void {
  appendFileSync(storePath, JSON.stringify(result) + "\n", "utf8")
}

export function readResults(storePath: string): RuleResult[] {
  if (!existsSync(storePath)) return []
  return readFileSync(storePath, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as RuleResult)
}
