import { matchRules } from "../match/matcher"
import { changedFiles, type Source } from "../source/types"
import { readResults } from "../findings/store"
import { computeGate, type GateResult } from "../gate/gate"
import { runOrchestrator, type PromptClient } from "./run"
import type { Rule } from "../config/schema"

export interface ReviewOptions {
  rules: Rule[]
  source: Source
  client: PromptClient
  storePath: string
  failOpen: boolean
}

/** The full deterministic spine; the LLM work happens inside client.prompt. */
export async function runReview(opts: ReviewOptions): Promise<GateResult> {
  const sourceResult = await opts.source.read()
  const items = matchRules(changedFiles(sourceResult), opts.rules)

  if (items.length > 0) {
    process.env.REVIEW_STORE_PATH = opts.storePath
    await runOrchestrator(opts.client, { items, diffByFile: sourceResult.diffByFile })
  }

  const results = readResults(opts.storePath)
  return computeGate(results, items.map((i) => i.rule.id), opts.failOpen)
}
