import { createHash } from "node:crypto"
import type { Finding, RuleResult } from "../findings/types"

export interface GithubCtx {
  owner: string
  repo: string
  pull_number: number
  commit_id: string
}

/** Minimal surface we need from octokit — keeps the module testable. */
export interface ReviewClient {
  listReviewComments(): Promise<Array<{ body?: string }>>
  createReviewComment(body: string, file: string, line: number): Promise<void>
}

export function fingerprint(f: Finding): string {
  // Key on STABLE attributes only (rule + location). The explanation wording is
  // LLM-generated and varies between runs, so including it would defeat dedup —
  // a re-run would post a near-identical comment with a different marker.
  return createHash("sha1").update(`${f.ruleId}:${f.file}:${f.line}`).digest("hex").slice(0, 12)
}

function marker(f: Finding): string {
  return `<!-- review-agent:${f.ruleId}:${fingerprint(f)} -->`
}

/** Post each finding as an inline review comment, skipping any already present. */
export async function postGithubResult(
  client: ReviewClient,
  _ctx: GithubCtx,
  result: RuleResult,
): Promise<void> {
  const existing = await client.listReviewComments()
  const existingMarkers = new Set(
    existing.flatMap((c) => {
      const m = c.body?.match(/<!-- review-agent:[^>]+? -->/g)
      return m ?? []
    }),
  )
  for (const f of result.findings) {
    if (existingMarkers.has(marker(f))) continue
    const icon = f.severity === "error" ? "❌" : "⚠️"
    const fix = f.suggestedFix ? `\n\n**Suggested fix:** ${f.suggestedFix}` : ""
    const body = `${icon} **${f.layer} / ${f.ruleId}**\n\n${f.explanation}${fix}\n\n${marker(f)}`
    await client.createReviewComment(body, f.file, f.line)
  }
}
