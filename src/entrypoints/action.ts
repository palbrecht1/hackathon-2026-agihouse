import { join } from "node:path"
import { Octokit } from "@octokit/rest"
import { runReview } from "../orchestrator/harness"
import { createSdkClient } from "../orchestrator/sdkClient"
import { loadRules } from "../config/loader"
import { GitHubPRSource } from "../source/githubPr"
import type { GithubCtx } from "../report/github"
import { renderSummaryMarkdown } from "../report/summary"
import { readResults } from "../findings/store"
import { DEFAULT_MODEL, readFailOpen } from "./shared"

async function main() {
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? "/").split("/")
  const pull_number = Number(process.env.PR_NUMBER)
  const commit_id = process.env.PR_HEAD_SHA!
  const ctx: GithubCtx = { owner: owner!, repo: repo!, pull_number, commit_id }
  const model = process.env.REVIEW_MODEL ?? DEFAULT_MODEL
  const storePath = join(process.env.RUNNER_TEMP ?? ".", `review-store-${pull_number}.jsonl`)

  // Reporter tool reads these.
  process.env.REVIEW_MODE = "github"
  process.env.REVIEW_STORE_PATH = storePath
  process.env.REVIEW_GH_OWNER = owner ?? ""
  process.env.REVIEW_GH_REPO = repo ?? ""
  process.env.REVIEW_GH_PR = String(pull_number)
  process.env.REVIEW_GH_SHA = commit_id

  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN })
  const rules = loadRules(".reviews")
  const sdk = await createSdkClient(model, rules)
  try {
    const gate = await runReview({
      rules,
      source: new GitHubPRSource(octokit, ctx),
      client: sdk.client,
      storePath,
      failOpen: readFailOpen(),
    })

    // Post or update the PR summary comment (deduplicated via hidden marker).
    const SUMMARY_MARKER = "<!-- layered-review-summary -->"
    const summaryBody = `${renderSummaryMarkdown(readResults(storePath))}\n\n${SUMMARY_MARKER}`
    const priorComments = await octokit.paginate(octokit.issues.listComments, {
      owner: owner!,
      repo: repo!,
      issue_number: pull_number,
      per_page: 100,
    })
    const prior = priorComments.find(
      (c: { id: number; body?: string }) => c.body?.includes(SUMMARY_MARKER),
    )
    if (prior) {
      await octokit.issues.updateComment({
        owner: owner!,
        repo: repo!,
        comment_id: prior.id,
        body: summaryBody,
      })
    } else {
      await octokit.issues.createComment({
        owner: owner!,
        repo: repo!,
        issue_number: pull_number,
        body: summaryBody,
      })
    }

    await octokit.repos.createCommitStatus({
      owner: owner!,
      repo: repo!,
      sha: commit_id,
      state: gate.passed ? "success" : "failure",
      context: "layered-review",
      description: gate.passed
        ? "No blocking violations"
        : gate.errorFindings > 0
          ? `${gate.errorFindings} blocking error finding(s)`
          : `${gate.erroredRuleIds.length + gate.unevaluatedRuleIds.length} rule(s) could not be evaluated`,
    })
    process.exit(gate.passed ? 0 : 1)
  } finally {
    await sdk.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
