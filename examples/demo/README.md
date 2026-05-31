# PR Review Agent — Demo Example

This directory contains a self-contained demo that exercises three review layers, a custom tool, and two source files with planted violations.

## What the demo contains

### Review layers (`examples/demo/.reviews/`)

| File | Layer | Rule ID | Severity | What it checks |
|------|-------|---------|----------|----------------|
| `mvc.yaml` | MVC | `service-no-db` | error | Services must not import or call the DB/ORM client directly — persistence must go through a repository |
| `neverthrow.yaml` | Error handling | `no-try-catch` | warn | New code must return `Result` (neverthrow) instead of throwing; new `try/catch` blocks are flagged |
| `sql.yaml` | SQL | `query-explain` | error | Each new/modified SQL string is passed to the custom `sql_explain` tool; any plan containing "Seq Scan" is flagged |

### Custom tool (`examples/demo/.opencode/tool/sql_explain.ts`)

The `sql_explain` tool is a project-local OpenCode plugin that runs `EXPLAIN` on a SQL query against the dev database and returns the query plan. The reviewer subagent for the `query-explain` rule calls this tool automatically (declared in `sql.yaml` via `tools: [sql_explain]`). In the demo stub the tool shells out to `psql`; set `DEV_DATABASE_URL` to point it at a real Postgres instance.

### Planted violations (`examples/demo/src/`)

| File | Violation | Rule triggered |
|------|-----------|----------------|
| `src/services/billing.ts` | `db.query(...)` called directly inside a service | `service-no-db` (error) |
| `src/services/billing.ts` | `try { … } catch (e) { throw new Error(…) }` | `no-try-catch` (warn) |
| `src/queries/customers.sql.ts` | `SELECT * FROM customers WHERE email = $1` — no index on `email` | `query-explain` (error, if a dev DB is configured) |

## Expected findings

After a run against the planted violations you should see:

1. **`service-no-db` — ERROR** on the `db.query` line in `src/services/billing.ts`
   > Service imports and calls the DB client directly instead of going through a repository.

2. **`no-try-catch` — WARN** on the `try/catch` block in `src/services/billing.ts`
   > New try/catch with a thrown exception; migrate to neverthrow `Result` instead.

3. **`query-explain` — ERROR** on `findByEmail` in `src/queries/customers.sql.ts` *(requires a configured dev DB)*
   > EXPLAIN plan contains "Seq Scan"; add an index on `customers.email`.

The process exits non-zero (`FAIL`) when any `error`-severity finding is present. The newest file at `.review-output/<epoch-ms>/findings.json` will contain the structured findings array.

## What this directory is

`examples/demo/` is an **illustrative config set** — review layers (`.reviews/`), a custom `sql_explain` tool (`.opencode/tool/sql_explain.ts`), and source files with planted violations (`src/`). It is not a standalone runnable project. The reporter tool that records findings lives at `.opencode/tool/report.ts` in the **framework root** and imports from `src/` there; it is only discoverable when the process runs from the framework repo root.

## Running a review against the demo config

To actually run a review that records findings, the reporter tool must be on the discovery path. That means running from the **framework repo root** (the directory that contains both `.opencode/tool/report.ts` and `src/`).

**Step 1 — copy demo assets into the framework root:**

```bash
# From the framework root:
cp -r examples/demo/.reviews .reviews
cp examples/demo/.opencode/tool/sql_explain.ts .opencode/tool/sql_explain.ts
cp -r examples/demo/src src   # the planted-violation files
```

**Step 2 — establish a git base to diff against:**

```bash
git add -A && git commit -m "base"
# (or use any existing commit as your base-ref)
```

**Step 3 — run from the framework root:**

```bash
export ANTHROPIC_API_KEY=...        # required
export DEV_DATABASE_URL=...         # optional — enables the sql_explain tool
bun run src/entrypoints/cli.ts main
```

Expected outcome: exits non-zero (`FAIL`); inspect `.review-output/<epoch-ms>/findings.json` for the structured findings listed above. Do **not** `cd examples/demo` before running — doing so will prevent OpenCode from discovering the reporter tool and the review will not function.

## GitHub Action path

The same rule files work when running via the bundled GitHub Action (`.github/workflows/layered-review.yml`). In GitHub mode the agent posts inline comments on the pull request instead of writing local files, gated by a `layered-review` status check. Set `ANTHROPIC_API_KEY` as a repository secret and the workflow triggers automatically on every pull request.
