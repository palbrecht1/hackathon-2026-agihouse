#!/usr/bin/env bun
import { join } from "node:path"
import { runReview } from "../orchestrator/harness"
import { createSdkClient } from "../orchestrator/sdkClient"
import { loadRules } from "../config/loader"
import { LocalGitSource } from "../source/localGit"
import { readResults } from "../findings/store"
import { writeLocalOutput } from "../report/local"

async function main() {
  const base = process.argv[2] ?? "main"
  const model = process.env.REVIEW_MODEL ?? "anthropic/claude-sonnet-4-5"
  const epochMs = Date.now()
  const storePath = join(".review-output", `.store-${epochMs}.jsonl`)

  process.env.REVIEW_MODE = "local"
  process.env.REVIEW_STORE_PATH = storePath

  const rules = loadRules(".reviews")
  const sdk = await createSdkClient(model, rules)
  try {
    const gate = await runReview({
      rules,
      source: new LocalGitSource(base),
      client: sdk.client,
      storePath,
      failOpen: process.env.REVIEW_FAIL_OPEN === "true",
    })
    const dir = writeLocalOutput(readResults(storePath), ".review-output", epochMs)
    console.log(`Review written to ${dir} — ${gate.passed ? "PASS" : "FAIL"}`)
    process.exit(gate.passed ? 0 : 1)
  } finally {
    await sdk.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
