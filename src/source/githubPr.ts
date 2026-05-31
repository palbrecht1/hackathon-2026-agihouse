import type { Octokit } from "@octokit/rest"
import type { GithubCtx, ReviewClient } from "../report/github"
import type { Source, SourceResult } from "./types"

/** Reads the PR's changed files and per-file patch via the GitHub API. */
export class GitHubPRSource implements Source {
  constructor(private octokit: Octokit, private ctx: GithubCtx) {}

  async read(): Promise<SourceResult> {
    const files = await this.octokit.paginate(this.octokit.pulls.listFiles, {
      owner: this.ctx.owner,
      repo: this.ctx.repo,
      pull_number: this.ctx.pull_number,
      per_page: 100,
    })
    const diffByFile: Record<string, string> = {}
    for (const f of files) {
      if (f.patch) diffByFile[f.filename] = f.patch
    }
    return { diffByFile }
  }
}

/** Build the ReviewClient used by the github reporter from a live octokit. */
export function githubReviewClient(octokit: Octokit, ctx: GithubCtx): ReviewClient {
  return {
    listReviewComments: async () =>
      octokit
        .paginate(octokit.pulls.listReviewComments, {
          owner: ctx.owner,
          repo: ctx.repo,
          pull_number: ctx.pull_number,
          per_page: 100,
        })
        .then((comments) => comments.map((c) => ({ body: c.body }))),
    createReviewComment: async (body, file, line) => {
      await octokit.pulls.createReviewComment({
        owner: ctx.owner,
        repo: ctx.repo,
        pull_number: ctx.pull_number,
        commit_id: ctx.commit_id,
        body,
        path: file,
        line,
        side: "RIGHT",
      })
    },
  }
}
