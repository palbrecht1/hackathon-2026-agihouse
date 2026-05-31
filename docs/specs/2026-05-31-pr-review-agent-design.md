# Layered PR Review Agent — Design

**Date:** 2026-05-31
**Status:** Approved design, pre-implementation

## Problem

Rules added to `CLAUDE.md` go unenforced. When a coding agent (or a human)
works in an existing codebase, it follows the patterns it sees and ignores
written rules — especially during migrations (e.g. "use neverthrow instead of
try/catch"), where the existing code actively contradicts the new rule. We need
an enforcement layer that reviews changes against rules **independently of what
the surrounding codebase already does**.

## Goal

A reusable, repo-agnostic, config-driven OSS framework: an AI PR review agent
built on OpenCode that enforces layered rules. An **orchestrator** dispatches one
**rule-reviewer subagent per rule**, then validates, dedups, and reports
findings. Only the orchestrator can report; subagents only read and judge.

## Core concepts

- **Rule** — the atomic unit of review: an `id`, a `glob` that enables it, a
  `severity` (`error` | `warn`), and `rule` prose (the prompt). Each rule is
  dispatched to its own subagent.
- **Layer** — a named bundle of rules that share a `description` (context).
  A layer can describe a structure (MVC, an interface boundary) or a concept
  (error-handling style). A "global" rule is just a rule with a broad glob.
  Layers provide shared context once so rules stay DRY; they do not change the
  per-rule dispatch model.

## Configuration contract — `.reviews/*.yaml`

One file per layer, discovered by glob. Validated with zod at load time; a
malformed config fails loudly before any model call.

```yaml
# .reviews/mvc.yaml
layer: MVC
description: |
  This codebase follows MVC. Controllers handle HTTP only.
  Services hold business logic and must never touch the DB directly —
  all persistence goes through repositories.
rules:
  - id: controller-pure-http
    glob: "src/controllers/**/*.ts"
    severity: error
    rule: |
      Controllers must only translate HTTP <-> domain calls. Flag any
      business logic, DB access, or direct service-to-service orchestration.

  - id: service-no-db
    glob: "src/services/**/*.ts"
    severity: error
    rule: |
      Services must not import or call the DB client directly. They must
      go through a repository. Flag direct DB/ORM usage.
```

```yaml
# .reviews/neverthrow.yaml  — a "global" layer: broad glob, conceptual rule
layer: Error handling
description: |
  We are migrating to neverthrow. New code must return Result types
  instead of throwing. Existing try/catch patterns in the codebase are
  legacy — do NOT treat them as precedent.
rules:
  - id: no-try-catch
    glob: "src/**/*.ts"
    severity: warn
    rule: |
      Flag new try/catch blocks and thrown exceptions in changed code.
      New fallible functions should return Result<T, E> from neverthrow.
```

```yaml
# .reviews/sql.yaml  — a layer whose reviewer gets a custom validation tool
layer: SQL
description: |
  Raw SQL must be valid and not trigger a sequential scan on large tables.
tools: [sql_explain]            # layer-level: every rule's reviewer gets this tool
rules:
  - id: query-explain
    glob: "src/**/*.sql.ts"
    severity: error
    rule: |
      For each newly added or modified SQL query, run sql_explain on it and
      flag any full-table/sequential scan or missing index usage.
    tools: [sql_explain]        # rule-level tools merge with the layer's
```

### Schema

- **Layer file:** `layer: string`, `description: string`,
  `tools?: string[]` (optional), `rules: Rule[]`.
- **Rule:** `id: string` (unique across all layers; used for dedup),
  `glob: string`, `severity: "error" | "warn"`, `rule: string`,
  `tools?: string[]` (optional). A rule's **effective tool set** is the union of
  its layer's `tools` and its own `tools`.

### Custom reviewer tools

A rule's reviewer subagent can be granted extra **read/validation tools** beyond
the default read-only file access — e.g. a `sql_explain` tool that runs `EXPLAIN`
on newly added queries against a dev database, a schema-linter, an HTTP probe.

- Custom tools are **standard OpenCode custom tools** authored with
  `@opencode-ai/plugin`'s `tool()` helper and placed in the consumer repo's
  `.opencode/tool/<name>.ts` (the same directory our `report` tool ships to).
  The framework references them **by name** in a rule/layer's `tools` — it does
  not load or own them, so consumers add tools without touching the framework.
- The reviewer for a rule with custom tools is a **generated specialized
  subagent** granted `permission` for exactly those tool names (plus the default
  read-only access). Rules with no custom tools share the generic `rule-reviewer`.
- **The reporter tool is never grantable this way.** Custom tools are
  read/validation only; the permission generator always denies the reporter tool
  (and `edit`/`bash`) to every subagent, custom-tooled or not. The "only the
  orchestrator reports" guarantee is unaffected.

## Architecture — `Source → Matcher → Orchestrator(+subagents) → Reporter`

Two interchangeable ends (Source, Reporter) around a fixed core. The same
orchestrator runs from GitHub Actions or locally; only the adapters differ.

### Components (each independently testable)

1. **Config loader/validator** — discovers `.reviews/*.yaml`, parses,
   zod-validates, flattens into `Rule[]` where each rule carries its layer's
   `description` as context.
2. **Matcher** (pure code, not an LLM) — `(changedFiles, rules) → DispatchItem[]`,
   each `{ rule, matchedFiles[] }`. Deterministic glob matching (picomatch).
   Rules matching zero changed files are dropped.
3. **Source adapter** (input, plain code — runs before the agent) — produces
   `{ changedFiles, diff }`:
   - `GitHubPRSource` — via octokit, from the PR event.
   - `LocalGitSource` — `git diff <base>...HEAD` (or working tree vs base).
   The source result is serialized into the orchestrator's opening prompt.
4. **Rule-reviewer subagent** (OpenCode `mode: subagent`) — input: one rule + its
   layer context + the diff for matched files + read-only repo access
   (`read`/`glob`/`grep` allowed; `edit`/`bash`/`task`/reporter-tools denied),
   **plus any custom tools the rule declares** (e.g. `sql_explain`). Rules
   without custom tools share the generic `rule-reviewer`; rules with custom
   tools get a generated specialized agent (`rule-reviewer-{ruleId}`) granted
   exactly those tools. Output: returns its findings as `<task_result>` text to
   the orchestrator — `Finding[]` = `{ ruleId, layer, file, line, severity,
   explanation, confidence, suggestedFix? }`. **Holds no reporter and no write
   tools.**
5. **Orchestrator** (OpenCode `mode: primary`, an LLM agent) — bootstrapped
   *programmatically via `@opencode-ai/sdk`* by the entrypoint (not the `opencode
   run` CLI), then handed the dispatch list + diff in its opening prompt. The
   dispatch list tells it which subagent (`rule-reviewer` or a specialized
   `rule-reviewer-{ruleId}`) to use for each rule. It fans out one reviewer
   subagent per `DispatchItem` via the `task` tool,
   collects their findings, **validates** (drops low-confidence / false
   positives), and **posts** surviving findings by calling the **reporter
   tool** it has been granted. Sole holder of the reporter tool.
6. **Reporter tools** (output, OpenCode custom tools — `.opencode/tool/*.ts`,
   gated so only the orchestrator agent has `permission`) — consume findings the
   orchestrator passes them. Exactly one is registered per run, chosen by the
   entrypoint:
   - `report_github` — posts inline comments + summary; owns **deterministic
     dedup inside the tool** (skips any finding whose
     `<!-- review-agent:{ruleId}:{fingerprint} -->` marker already exists on the
     PR). Records each posted finding's severity into an in-process result store.
   - `report_local` — appends each finding to the in-process result store; the
     harness flushes the store to `.review-output/<epoch-ms>/` after the session.
   Each posted finding is recorded to a shared **result store** so the gate stays
   deterministic (see below).
7. **Entrypoints** (each: run Source → Matcher in code, boot orchestrator via
   SDK with the right reporter tool registered, then deterministically set the
   gate from the result store):
   - **GitHub Action workflow** — wires `GitHubPRSource` + `report_github`,
     provides tokens; sets the PR **status check** from the result store.
   - **CLI** (`review` command) — wires `LocalGitSource` + `report_local`;
     writes `.review-output/<epoch-ms>/` and sets the **exit code** from the
     result store.

### The "only the orchestrator reports" guarantee

Enforced two ways: (1) only the orchestrator agent is granted `permission` for
the reporter tool — subagents have it denied; (2) the entrypoint registers
exactly one reporter tool per run. Subagents return findings only as
`<task_result>` text, so they structurally cannot post, comment, or write
output.

### Deterministic gate over an LLM-driven core

Fan-out, judging, validation, and posting are LLM-driven, but the **pass/fail
gate is not**. Every finding the reporter tool posts is recorded to a shared
result store; after the SDK session ends, the entrypoint reads the store and
deterministically computes the outcome (fail if any posted `error` survived,
respecting the fail-closed rule for errored subagents). The model never decides
the merge gate.

## Local output format — `.review-output/<epoch-ms>/`

Each run writes a fresh timestamped directory (no dedup; an iterating agent
wants current truth and a sortable history). Consumers sort descending to get
the latest run. `.review-output/` is gitignored by default.

```
.review-output/
  1733000000000/
    findings.json   # machine-readable contract for local AI agents
    summary.md      # human-readable digest grouped by layer/severity
  1733000123456/
    findings.json
    summary.md
```

`findings.json` is the contract a local AI agent reads, fixes against, and
re-runs to iterate. No `latest` symlink — sorting is simpler and cross-platform.

## Data flow

```
PR event / CLI invocation
   │
   ▼
Entrypoint wires Source + Reporter
   │
   ├─ Config loader → Rule[]            (zod-validated; bad config = hard fail)
   ├─ Source        → { changedFiles, diff }
   ▼
Matcher (pure)     → DispatchItem[]     (empty ⇒ skip/pass, no noise)
   │
   ▼
Entrypoint boots orchestrator via @opencode-ai/sdk,
prompt = dispatch list + diff; one reporter tool registered
   │
   ▼
Orchestrator (OpenCode primary, LLM)
   ├─ fan out: one rule-reviewer subagent per DispatchItem (task tool)
   │     each subagent: rule + layer context + diff + read-only repo → Finding[]
   ├─ collect findings (<task_result> text)
   ├─ validate: drop low-confidence / false positives
   └─ post surviving findings via the granted reporter tool
        ├─ report_github: dedup-in-tool → inline comments + summary
        └─ report_local:  buffer findings → result store
   │
   ▼
Session ends → entrypoint reads result store → deterministic gate
   ├─ GitHub: set PR status check
   └─ Local:  write .review-output/<epoch-ms>/ + set exit code
```

## Error handling

- **Invalid config** — fail loudly before any model call, naming the file +
  field. The config is the contract.
- **Subagent failure/timeout** — the orchestrator records the rule as `errored`
  in the result store via the reporter tool; the entrypoint's deterministic gate
  **fails closed** by default (errored rule = non-passing check / non-zero exit),
  with a config flag to fail open. The gate, not the model, enforces this — so a
  rule the orchestrator silently dropped still fails closed if no result was
  recorded for it. An enforcement tool must not skip a rule it could not
  evaluate.
- **No matched rules** — pass/skip, no output noise.
- **Model nondeterminism** — a per-finding confidence threshold plus the
  orchestrator's validation pass are the guardrails against false-positive spam.

## Testing

TypeScript; typecheck with `tsgo --noEmit`. TDD the pure pieces.

- **Unit:** config loader/validator (valid + each malformed case), matcher
  (glob edge cases), result-store → gate mapping (severity → check/exit-code,
  fail-closed on missing/errored rule), local-output writer shape, GitHub
  dedup-fingerprint logic.
- **Integration:** fixture diffs ("golden PRs") with seeded violations driven
  through the full harness against a fake OpenCode SDK client (scripted
  subagent + reporter-tool calls) for deterministic orchestration tests.
- **Live smoke / demo:** a sample repo with planted violations (an impure
  controller, a raw try/catch, a partner API call bypassing the interface) run
  through both entrypoints.

## Tech stack

- **Language:** TypeScript (typecheck via `tsgo --noEmit`); Bun runtime + test
  runner (`bun test`).
- **Agent runtime:** OpenCode — primary orchestrator agent + `mode: subagent`
  rule reviewers via the `task` tool; per-agent `permission` config enforces the
  reporter guarantee. Bootstrapped programmatically with `@opencode-ai/sdk`
  (`createOpencode` + `session.prompt`); reporter tools authored with
  `@opencode-ai/plugin`'s `tool()` helper under `.opencode/tool/`.
- **Model/auth:** `anthropic/claude-*` via `ANTHROPIC_API_KEY` (env, CI-friendly).
- **Schema:** zod for config validation.
- **Globs:** picomatch.
- **GitHub:** octokit for PR diff, comments, and status checks.

## Out of scope (YAGNI for now)

- Local dedup / incremental local runs (timestamped dirs supersede this).
- A `latest` symlink in `.review-output/`.
- Auto-fixing violations (reviewers report; fixing is the consumer's job).
- Rule severities beyond `error` / `warn`.
