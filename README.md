# Layered PR Review Agent

A reusable, config-driven AI PR review agent built on [OpenCode](https://opencode.ai). An orchestrator (OpenCode primary agent) dispatches one read-only rule-reviewer subagent per matched rule, validates findings, and reports them. Only the orchestrator can report — the pass/fail gate is deterministic, not model-decided.

---

## Table of contents

1. [What it is](#what-it-is)
2. [How it runs (self-hosted model)](#how-it-runs-self-hosted-model)
3. [The `.reviews/*.yaml` config contract](#the-reviewsyaml-config-contract)
4. [Custom reviewer tools](#custom-reviewer-tools)
5. [Local usage](#local-usage)
6. [Model and provider config](#model-and-provider-config)
7. [GitHub Action](#github-action)
8. [Architecture](#architecture)
9. [Dev](#dev)

---

## What it is

Rules added to `CLAUDE.md` or a wiki go unenforced: when a coding agent works in a codebase it follows the patterns it sees, ignoring written rules — especially during migrations where existing code actively contradicts the new rule. This tool is an enforcement layer that reviews changes against rules **independently of what the surrounding codebase already does**.

Core properties:

- **Config-driven** — one YAML file per rule layer, discovered at runtime from `.reviews/`. No code changes to add a rule.
- **Per-rule subagent isolation** — each rule is reviewed by its own read-only subagent. Rules cannot influence each other.
- **Deterministic gate** — the pass/fail outcome is computed from a result store after the session ends. The model never decides whether a PR merges.
- **Fail-closed** — if a dispatched rule has no recorded result (subagent errored or was silently dropped), the gate fails by default.
- **Two entrypoints, same core** — runs locally (CLI) or as a GitHub Action. Only the source adapter and reporter tool differ.

---

## How it runs (self-hosted model)

**This framework is self-hosted.** The CLI and GitHub Action must run from the root of the repository being reviewed, because the `@opencode-ai/sdk` spawns the `opencode` CLI as a subprocess and the CLI discovers custom tools from `<cwd>/.opencode/tool/`. The framework's reporter tool lives at `.opencode/tool/report.ts` in this repo and imports from `src/` via relative paths — it is only found when the process runs from the repo root where both `.opencode/tool/report.ts` and `src/` exist.

**Concretely:** add this framework (its `src/`, `.opencode/`, and your `.reviews/` config) to the repository whose PRs you want reviewed, and run the CLI or Action from that repo's root. Running from a subdirectory will not discover the reporter tool and the review will fail silently.

**The `opencode` CLI must be on PATH.** The SDK does not include the CLI — it spawns it from the environment.

- **Locally:** install OpenCode normally (e.g. `npm install -g opencode-ai`).
- **In CI:** the bundled workflow installs it automatically before running the action (`npm install -g opencode-ai`).

> **Future work:** cross-repo distribution as an installable npm package or reusable GitHub Action (where consumers install the framework as a dependency without copying source) is not yet supported. Today the framework must live in the repo root it reviews.

---

## The `.reviews/*.yaml` config contract

Place one YAML file per layer in `.reviews/`. All files matching `*.yaml` / `*.yml` are discovered and sorted alphabetically. The config is validated with zod at startup — a malformed file fails loudly before any model call.

### Schema

**Layer file:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `layer` | string | yes | Human name for the layer (used in output) |
| `description` | string | yes | Shared context injected into every reviewer subagent for this layer |
| `tools` | string[] | no | Tool names granted to every rule reviewer in this layer |
| `rules` | Rule[] | yes | At least one rule |

**Rule:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Unique across all layers; used for dedup and result tracking |
| `glob` | string | yes | Only changed files matching this glob trigger this rule |
| `severity` | `"error"` \| `"warn"` | yes | `error` blocks the gate; `warn` posts a comment only |
| `rule` | string | yes | The review prompt for the subagent |
| `tools` | string[] | no | Additional tool names for this rule's reviewer |

A rule's **effective tool set** is the union of its layer's `tools` and its own `tools`.

Rules matching zero changed files are silently skipped (no noise on irrelevant PRs).

### Examples

**`mvc.yaml` — structural layer**

```yaml
layer: MVC
description: |
  Services hold business logic and must never touch the DB directly —
  persistence goes through a repository.
rules:
  - id: service-no-db
    glob: "src/services/**/*.ts"
    severity: error
    rule: |
      Services must not import or call the DB/ORM client directly. Flag
      direct DB access; it must go through a repository.
```

**`neverthrow.yaml` — conceptual / migration layer**

```yaml
layer: Error handling
description: |
  We are migrating to neverthrow. New code returns Result instead of throwing.
  Existing try/catch is legacy — do NOT treat it as precedent.
rules:
  - id: no-try-catch
    glob: "src/**/*.ts"
    severity: warn
    rule: Flag new try/catch blocks and thrown exceptions in changed code.
```

**`sql.yaml` — layer with a custom validation tool**

```yaml
layer: SQL
description: Raw SQL must not trigger a sequential scan on a large table.
tools: [sql_explain]
rules:
  - id: query-explain
    glob: "src/**/*.sql.ts"
    severity: error
    rule: |
      For each newly added or modified SQL string, call the sql_explain tool
      with that query and flag any plan containing "Seq Scan".
```

`error` findings block the merge gate. `warn` findings are posted as comments but do not block.

---

## Custom reviewer tools

A rule or layer can grant its reviewer subagent extra read-only validation tools beyond the default file access (`read`, `glob`, `grep`). Examples: run `EXPLAIN` on a new SQL query against a dev database, call a schema linter, probe an HTTP endpoint.

**How it works:**

1. Author a tool using `@opencode-ai/plugin`'s `tool()` helper and place it in `.opencode/tool/<name>.ts` in the consumer repo (same directory the framework's `report` tool ships to).
2. Reference the tool by name in the layer or rule's `tools` array.
3. The framework generates a specialized subagent (`rule-reviewer-{ruleId}`) granted permission for exactly those tool names — in addition to the default read-only access.

**Security invariant:** the reporter tool is never grantable to a subagent. The permission builder always denies it (and `edit`/`bash`/`task`) to every reviewer, regardless of what `tools` lists. The "only the orchestrator reports" guarantee is structural.

**Example — `examples/demo/.opencode/tool/sql_explain.ts`:**

```typescript
import { tool } from "@opencode-ai/plugin"

export default tool({
  description: "Run EXPLAIN on a SQL query against the dev database and return the plan.",
  args: { query: tool.schema.string().describe("The SQL query to explain") },
  async execute(args) {
    const proc = Bun.spawn(["psql", process.env.DEV_DATABASE_URL ?? "", "-c", `EXPLAIN ${args.query}`], { stdout: "pipe", stderr: "pipe" })
    const out = await new Response(proc.stdout).text()
    const err = await new Response(proc.stderr).text()
    return out || `EXPLAIN failed: ${err}`
  },
})
```

Referenced from `examples/demo/.reviews/sql.yaml` via `tools: [sql_explain]`. Set `DEV_DATABASE_URL` to point it at a real Postgres instance; the demo stub shells out to `psql`.

---

## Local usage

Run from the **repo root** (where `.opencode/tool/report.ts` and `src/` live — see [How it runs](#how-it-runs-self-hosted-model)):

```bash
ANTHROPIC_API_KEY=... bun run src/entrypoints/cli.ts [base-ref]
```

`base-ref` defaults to `main`. The CLI diffs `git diff <base>...HEAD`, loads `.reviews/`, and runs the full review.

**Output** is written to a fresh timestamped directory:

```
.review-output/
  1733000000000/
    findings.json    # machine-readable: Finding[] contract for local AI agents
    summary.md       # human-readable digest grouped by layer/severity
  1733000123456/
    findings.json
    summary.md
```

Sort descending by directory name to get the latest run. `.review-output/` is gitignored by default.

**Exit codes:**

- `0` — passed (no `error` findings, no errored/unevaluated rules)
- `1` — failed (confirmed `error` finding, or errored/unevaluated rule in fail-closed mode)
- `2` — unexpected exception

**Fail-open mode:** set `REVIEW_FAIL_OPEN=true` to treat errored or unevaluated rules as non-blocking (still reported).

**Local iteration workflow:** after a run, a local AI agent can read the newest `findings.json`, apply fixes, and re-run the CLI to iterate until the gate passes.

---

## Model and provider config

**Model:** set `REVIEW_MODEL` to any OpenCode model string (format: `<provider>/<modelId>`). Default: `anthropic/claude-sonnet-4-5`.

```bash
export REVIEW_MODEL='anthropic/claude-opus-4-5'
bun run src/entrypoints/cli.ts main
```

**Custom provider:** for providers not built into OpenCode (e.g. an OpenAI-compatible gateway), set `OPENCODE_PROVIDER_JSON` to an OpenCode `provider` config block as a JSON string. The block is merged into the OpenCode config at boot. `{env:VAR}` placeholders in the JSON are resolved from the process environment — secrets stay out of the JSON value itself.

The model string format is `<providerKey>/<modelId>` where `providerKey` must match the top-level key in the JSON object.

**Example — Nebius Token Factory + Kimi K2.6:**

```bash
export NEBIUS_API_KEY=...   # your Nebius Token Factory key
export REVIEW_MODEL='nebius/moonshotai/Kimi-K2.6'
export OPENCODE_PROVIDER_JSON='{"nebius":{"npm":"@ai-sdk/openai-compatible","name":"Nebius Token Factory","options":{"baseURL":"https://api.tokenfactory.us-central1.nebius.com/v1/","apiKey":"{env:NEBIUS_API_KEY}"},"models":{"moonshotai/Kimi-K2.6":{}}}}'
bun run src/entrypoints/cli.ts main
```

How it resolves: the provider key is `nebius`, matching the prefix in `REVIEW_MODEL`. `{env:NEBIUS_API_KEY}` in the JSON is replaced with the value of `$NEBIUS_API_KEY` at startup.

---

## GitHub Action

Since the framework is self-hosted (see [How it runs](#how-it-runs-self-hosted-model)), the workflow runs in the repo being reviewed — the `checkout` step ensures the process runs from the repo root. The workflow installs the `opencode` CLI before invoking the action because `setup-bun` does not include it.

Copy `.github/workflows/layered-review.yml` into your repo:

```yaml
name: Layered Review
on:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  pull-requests: write
  statuses: write
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - name: Install OpenCode CLI (the SDK spawns it)
        run: npm install -g opencode-ai  # pin a version to match @opencode-ai/sdk if needed
      - run: bun run src/entrypoints/action.ts
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_REPOSITORY: ${{ github.repository }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
          PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}
```

**Required secrets:**

| Secret | Purpose |
|--------|---------|
| `ANTHROPIC_API_KEY` | Model auth for the default Anthropic provider |
| `GITHUB_TOKEN` | Built-in Actions token — no setup needed |

For a custom provider, add the provider's API key as a secret and set `OPENCODE_PROVIDER_JSON` and `REVIEW_MODEL` in the `env` block.

**What the Action does:**

- Reads the PR diff via the GitHub API (octokit).
- Runs the full review against `.reviews/` config.
- Posts inline comments on the PR for each finding (deduped via a hidden `<!-- review-agent:{ruleId}:{fingerprint} -->` marker so re-runs on the same commit don't duplicate comments).
- Posts a summary comment.
- Sets a `layered-review` commit status (`success` / `failure`) that can be configured as a required check to block merging.

The `layered-review` status check fails when any confirmed `error` finding is present, or when a dispatched rule has no result in fail-closed mode.

---

## Architecture

```
Source → Matcher (deterministic glob)
       → Orchestrator (LLM, primary agent, sole reporter-tool holder)
           └─ per-rule subagents (read-only, findings returned as text)
       → reporter tool (records to result store)
       → deterministic gate (reads result store, sets exit code / status check)
```

**Components:**

1. **Config loader** — discovers `.reviews/*.yaml`, zod-validates, flattens into `Rule[]`. Bad config = hard fail before any model call.
2. **Matcher** — pure code (picomatch). `(changedFiles, rules) → DispatchItem[]`. Rules with no matching changed files are dropped.
3. **Source adapter** — produces `{ changedFiles, diff }`. `LocalGitSource` uses `git diff <base>...HEAD`; `GitHubPRSource` uses the octokit API.
4. **Orchestrator** — an OpenCode `mode: primary` agent bootstrapped programmatically via `@opencode-ai/sdk` (`createOpencode` + `session.prompt`). Receives the dispatch list and diff in its opening prompt, fans out one reviewer subagent per rule via the `task` tool, collects findings, validates (drops confidence < 0.6), and posts survivors via the reporter tool.
5. **Rule-reviewer subagents** — OpenCode `mode: subagent`. Permissions: `read`/`glob`/`grep` allowed; `edit`/`bash`/`task`/`report` denied. Rules with custom tools get a dedicated `rule-reviewer-{ruleId}` agent granted exactly those tools. Return findings as `<task_result>` text — they structurally cannot post or write.
6. **Reporter tools** — OpenCode custom tools in `.opencode/tool/`. `report_local` buffers findings to the result store; `report_github` posts inline PR comments with deterministic dedup. Only the orchestrator agent has `permission` for this tool.
7. **Gate** — reads the result store after the session. Fails if any posted `error` finding exists, or if any dispatched rule has no recorded result and `REVIEW_FAIL_OPEN` is not set. The model never decides the gate.

**Fail-closed detail:** the gate checks every dispatched rule id against the result store. A rule the orchestrator silently dropped (never called the reporter for) counts as `unevaluated` and fails closed. `REVIEW_FAIL_OPEN=true` turns unevaluated/errored rules into non-blocking.

---

## Dev

```bash
bun install          # install dependencies
bun test             # run test suite
bunx tsgo --noEmit   # typecheck
```

The demo fixture lives in `examples/demo/`. See [`examples/demo/README.md`](examples/demo/README.md) for setup and expected findings.
