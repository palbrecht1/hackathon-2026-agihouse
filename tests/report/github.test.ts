import { test, expect } from "bun:test"
import { fingerprint, postGithubResult, type GithubCtx, type ReviewClient } from "../../src/report/github"
import type { RuleResult } from "../../src/findings/types"

function fakeClient(existingBodies: string[]): { client: ReviewClient; posted: string[] } {
  const posted: string[] = []
  const client: ReviewClient = {
    listReviewComments: async () => existingBodies.map((body) => ({ body })),
    createReviewComment: async (body) => { posted.push(body) },
  }
  return { client, posted }
}

const ctx: GithubCtx = { owner: "o", repo: "r", pull_number: 1, commit_id: "sha" }
const result: RuleResult = { ruleId: "no-db", status: "violations", findings: [
  { ruleId: "no-db", layer: "MVC", file: "src/s.ts", line: 4, severity: "error", explanation: "direct DB", confidence: 0.9 },
] }

test("posts a new finding with its marker", async () => {
  const { client, posted } = fakeClient([])
  await postGithubResult(client, ctx, result)
  expect(posted).toHaveLength(1)
  expect(posted[0]!).toContain("direct DB")
  const fp = fingerprint(result.findings[0]!)
  expect(posted[0]!).toContain(`<!-- review-agent:no-db:${fp} -->`)
})

test("skips a finding whose marker already exists (dedup)", async () => {
  const fp = fingerprint(result.findings[0]!)
  const { client, posted } = fakeClient([`old body <!-- review-agent:no-db:${fp} -->`])
  await postGithubResult(client, ctx, result)
  expect(posted).toHaveLength(0)
})

test("fingerprint is stable across explanation wording (re-run dedup)", async () => {
  // Same rule + file + line, but the explanation is reworded (as the LLM would
  // on a re-run). The marker must match so the comment is NOT posted twice.
  const reworded: RuleResult = {
    ...result,
    findings: [{ ...result.findings[0]!, explanation: "totally different wording this run" }],
  }
  expect(fingerprint(reworded.findings[0]!)).toBe(fingerprint(result.findings[0]!))
  const fp = fingerprint(result.findings[0]!)
  const { client, posted } = fakeClient([`prev <!-- review-agent:no-db:${fp} -->`])
  await postGithubResult(client, ctx, reworded)
  expect(posted).toHaveLength(0)
})
