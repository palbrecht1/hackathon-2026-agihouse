import { tool } from "@opencode-ai/plugin"
import { Octokit } from "@octokit/rest"
import { appendResult } from "../../src/findings/store"
import { postGithubResult, type GithubCtx } from "../../src/report/github"
import { githubReviewClient } from "../../src/source/githubPr"
import type { Finding, RuleResult } from "../../src/findings/types"

export default tool({
  description:
    "Record the review outcome for ONE rule. Call exactly once per rule. " +
    "On github mode this also posts inline comments for any violations.",
  args: {
    ruleId: tool.schema.string(),
    status: tool.schema.enum(["clean", "violations", "errored"]),
    reason: tool.schema.string().optional(),
    findings: tool.schema
      .array(
        tool.schema.object({
          ruleId: tool.schema.string(),
          layer: tool.schema.string(),
          file: tool.schema.string(),
          line: tool.schema.number(),
          severity: tool.schema.enum(["error", "warn"]),
          explanation: tool.schema.string(),
          confidence: tool.schema.number(),
          suggestedFix: tool.schema.string().optional(),
        }),
      )
      .default([]),
  },
  async execute(args) {
    const result: RuleResult = {
      ruleId: args.ruleId,
      status: args.status,
      findings: args.findings as Finding[],
      reason: args.reason,
    }

    const storePath = process.env.REVIEW_STORE_PATH
    if (!storePath) throw new Error("REVIEW_STORE_PATH not set")

    if (process.env.REVIEW_MODE === "github" && result.status === "violations") {
      const ctx: GithubCtx = {
        owner: process.env.REVIEW_GH_OWNER!,
        repo: process.env.REVIEW_GH_REPO!,
        pull_number: Number(process.env.REVIEW_GH_PR!),
        commit_id: process.env.REVIEW_GH_SHA!,
      }
      const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN })
      await postGithubResult(githubReviewClient(octokit, ctx), ctx, result)
    }

    appendResult(storePath, result)
    return `Recorded ${result.status} for rule ${result.ruleId} (${result.findings.length} finding(s)).`
  },
})
