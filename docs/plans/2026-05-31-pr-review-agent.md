# Layered PR Review Agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reusable, config-driven OpenCode-based agent that reviews a PR (or local diff) against layered rules, dispatching one rule-reviewer subagent per matched rule, and enforces results via a deterministic pass/fail gate.

**Architecture:** `Source → Matcher → Orchestrator(+subagents) → Reporter tool → deterministic gate`. The deterministic core (config, matcher, result store, gate, reporters' logic) is plain TypeScript, TDD'd against `bun test`. The orchestrator is an OpenCode `primary` LLM agent, bootstrapped programmatically via `@opencode-ai/sdk`; it fans out `mode: subagent` rule reviewers via the `task` tool and posts through a single reporter tool it alone is permitted to call. Subagents are read-only.

**Tech Stack:** TypeScript on Bun (`bun test`, typecheck `bunx tsgo --noEmit`); zod (config schema); picomatch (globs); `yaml` (parse); octokit (`@octokit/rest`, GitHub); `@opencode-ai/sdk` + `@opencode-ai/plugin` (OpenCode); model `anthropic/claude-*` via `ANTHROPIC_API_KEY`.

**Repo note:** This is a `jj` repository. Each "Commit" step uses `jj commit -m "..."`. After the final task, move the bookmark: `jj bookmark set main -r @-`.

---

## File Structure

```
package.json                      # deps, scripts (test, typecheck, build)
tsconfig.json                     # strict TS config
src/
  config/
    schema.ts                     # zod schemas + exported types (Rule, Layer, Severity)
    loader.ts                     # loadRules(reviewsDir) → Rule[]
  match/
    matcher.ts                    # matchRules(changedFiles, rules) → DispatchItem[]
  source/
    types.ts                      # Source, SourceResult, changedFiles() helper
    localGit.ts                   # LocalGitSource
    githubPr.ts                   # GitHubPRSource
  findings/
    types.ts                      # Finding, RuleResult, RuleStatus
    store.ts                      # appendResult/readResults (JSONL file, cross-process)
  gate/
    gate.ts                       # computeGate(results, dispatchedRuleIds, failOpen)
  report/
    summary.ts                    # renderSummaryMarkdown(results)
    local.ts                      # writeLocalOutput(results, baseDir, epochMs)
    github.ts                     # postGithubResult(octokit, ctx, result) with dedup
  orchestrator/
    prompt.ts                     # buildOrchestratorPrompt(dispatch, diffByFile)
    run.ts                        # runOrchestrator(client, opts)
  opencode/
    agents.ts                     # agent + permission config object for the SDK
  entrypoints/
    cli.ts                        # `review` local entrypoint
    action.ts                     # GitHub Action entrypoint
.opencode/
  tool/
    report.ts                     # the single reporter tool (thin wrapper over src/)
                                  # consumer repos add their own custom reviewer
                                  # tools here too (e.g. sql_explain.ts), referenced
                                  # by name in a rule/layer's `tools`
tests/                            # mirrors src/, bun test files
```

---

## Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore` (append)

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "layered-review",
  "version": "0.1.0",
  "type": "module",
  "bin": { "review": "./src/entrypoints/cli.ts" },
  "scripts": {
    "test": "bun test",
    "typecheck": "tsgo --noEmit"
  },
  "dependencies": {
    "@octokit/rest": "^21.0.0",
    "@opencode-ai/sdk": "^0.4.0",
    "@opencode-ai/plugin": "^0.4.0",
    "picomatch": "^4.0.2",
    "yaml": "^2.5.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/picomatch": "^3.0.1",
    "@typescript/native-preview": "latest"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "types": ["bun-types"],
    "allowImportingTsExtensions": true,
    "noEmit": true
  },
  "include": ["src", "tests", ".opencode"]
}
```

- [ ] **Step 3: Append `.review-output/` and `node_modules/` to `.gitignore`**

Append these two lines to `.gitignore`:

```
node_modules/
.review-output/
```

- [ ] **Step 4: Install deps**

Run: `bun install`
Expected: lockfile created, `node_modules/` populated, exit 0.

- [ ] **Step 5: Commit**

```bash
jj commit -m "chore: scaffold layered-review project"
```

---

## Task 2: Config schema (zod) + types

**Files:**
- Create: `src/config/schema.ts`
- Test: `tests/config/schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/config/schema.test.ts
import { test, expect } from "bun:test"
import { LayerFileSchema } from "../../src/config/schema"

test("valid layer file parses", () => {
  const parsed = LayerFileSchema.parse({
    layer: "MVC",
    description: "controllers handle HTTP only",
    rules: [
      { id: "controller-pure-http", glob: "src/controllers/**/*.ts", severity: "error", rule: "no logic" },
    ],
  })
  expect(parsed.rules[0]!.severity).toBe("error")
})

test("rejects unknown severity", () => {
  expect(() =>
    LayerFileSchema.parse({
      layer: "X",
      description: "d",
      rules: [{ id: "r", glob: "*", severity: "fatal", rule: "x" }],
    }),
  ).toThrow()
})

test("rejects rule missing id", () => {
  expect(() =>
    LayerFileSchema.parse({
      layer: "X",
      description: "d",
      rules: [{ glob: "*", severity: "warn", rule: "x" }],
    }),
  ).toThrow()
})

test("accepts optional tools at layer and rule level", () => {
  const parsed = LayerFileSchema.parse({
    layer: "SQL",
    description: "d",
    tools: ["sql_explain"],
    rules: [{ id: "q", glob: "*.sql.ts", severity: "error", rule: "explain", tools: ["sql_explain"] }],
  })
  expect(parsed.tools).toEqual(["sql_explain"])
  expect(parsed.rules[0]!.tools).toEqual(["sql_explain"])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/config/schema.test.ts`
Expected: FAIL — cannot find module `../../src/config/schema`.

- [ ] **Step 3: Write `src/config/schema.ts`**

```ts
import { z } from "zod"

export const SeveritySchema = z.enum(["error", "warn"])
export type Severity = z.infer<typeof SeveritySchema>

export const RuleSchema = z.object({
  id: z.string().min(1),
  glob: z.string().min(1),
  severity: SeveritySchema,
  rule: z.string().min(1),
  tools: z.array(z.string().min(1)).optional(),
})
export type RuleConfig = z.infer<typeof RuleSchema>

export const LayerFileSchema = z.object({
  layer: z.string().min(1),
  description: z.string().min(1),
  tools: z.array(z.string().min(1)).optional(),
  rules: z.array(RuleSchema).min(1),
})
export type LayerFile = z.infer<typeof LayerFileSchema>

/** A rule flattened with its layer's shared context — the atomic dispatch unit. */
export interface Rule {
  id: string
  layer: string
  layerDescription: string
  glob: string
  severity: Severity
  rule: string
  /** Custom reviewer tool names: union of the layer's and the rule's `tools`. */
  tools: string[]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/config/schema.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
bunx tsgo --noEmit
jj commit -m "feat: config schema and rule types"
```

---

## Task 3: Config loader

**Files:**
- Create: `src/config/loader.ts`
- Test: `tests/config/loader.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/config/loader.test.ts
import { test, expect } from "bun:test"
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadRules } from "../../src/config/loader"

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "reviews-"))
  const reviews = join(dir, ".reviews")
  mkdirSync(reviews)
  for (const [name, body] of Object.entries(files)) writeFileSync(join(reviews, name), body)
  return reviews
}

test("flattens rules and inherits layer description", () => {
  const dir = fixture({
    "mvc.yaml": `layer: MVC\ndescription: ctrl pure\nrules:\n  - id: a\n    glob: "src/**/*.ts"\n    severity: error\n    rule: no logic\n`,
  })
  const rules = loadRules(dir)
  expect(rules).toHaveLength(1)
  expect(rules[0]!.layer).toBe("MVC")
  expect(rules[0]!.layerDescription).toBe("ctrl pure")
  expect(rules[0]!.id).toBe("a")
})

test("throws a clear error naming file + field on bad config", () => {
  const dir = fixture({ "bad.yaml": `layer: X\ndescription: d\nrules:\n  - id: a\n    glob: "*"\n    severity: nope\n    rule: x\n` })
  expect(() => loadRules(dir)).toThrow(/bad\.yaml/)
})

test("throws on duplicate rule ids across files", () => {
  const dir = fixture({
    "a.yaml": `layer: A\ndescription: d\nrules:\n  - id: dup\n    glob: "*"\n    severity: warn\n    rule: x\n`,
    "b.yaml": `layer: B\ndescription: d\nrules:\n  - id: dup\n    glob: "*"\n    severity: warn\n    rule: y\n`,
  })
  expect(() => loadRules(dir)).toThrow(/dup/)
})

test("merges layer-level and rule-level tools (deduped)", () => {
  const dir = fixture({
    "sql.yaml": `layer: SQL\ndescription: d\ntools: [sql_explain]\nrules:\n  - id: q\n    glob: "*"\n    severity: error\n    rule: x\n    tools: [sql_explain, schema_lint]\n`,
  })
  const rules = loadRules(dir)
  expect(rules[0]!.tools.sort()).toEqual(["schema_lint", "sql_explain"])
})

test("rules with no tools get an empty tools array", () => {
  const dir = fixture({
    "a.yaml": `layer: A\ndescription: d\nrules:\n  - id: a\n    glob: "*"\n    severity: warn\n    rule: x\n`,
  })
  expect(loadRules(dir)[0]!.tools).toEqual([])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/config/loader.test.ts`
Expected: FAIL — cannot find module loader.

- [ ] **Step 3: Write `src/config/loader.ts`**

```ts
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parse as parseYaml } from "yaml"
import { LayerFileSchema, type Rule } from "./schema"

/** Discover `.reviews/*.yaml`, validate, and flatten into a deduped Rule[]. */
export function loadRules(reviewsDir: string): Rule[] {
  const files = readdirSync(reviewsDir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort()

  const rules: Rule[] = []
  const seen = new Map<string, string>() // ruleId -> file

  for (const file of files) {
    const raw = readFileSync(join(reviewsDir, file), "utf8")
    const result = LayerFileSchema.safeParse(parseYaml(raw))
    if (!result.success) {
      const issue = result.error.issues[0]!
      throw new Error(`Invalid review config in ${file} at "${issue.path.join(".")}": ${issue.message}`)
    }
    const layer = result.data
    for (const r of layer.rules) {
      const prior = seen.get(r.id)
      if (prior) throw new Error(`Duplicate rule id "${r.id}" in ${file} (already defined in ${prior})`)
      seen.set(r.id, file)
      const tools = [...new Set([...(layer.tools ?? []), ...(r.tools ?? [])])]
      rules.push({
        id: r.id,
        layer: layer.layer,
        layerDescription: layer.description,
        glob: r.glob,
        severity: r.severity,
        rule: r.rule,
        tools,
      })
    }
  }
  return rules
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/config/loader.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
bunx tsgo --noEmit
jj commit -m "feat: config loader with validation and dedup"
```

---

## Task 4: Matcher

**Files:**
- Create: `src/match/matcher.ts`
- Test: `tests/match/matcher.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/match/matcher.test.ts
import { test, expect } from "bun:test"
import { matchRules, type DispatchItem } from "../../src/match/matcher"
import type { Rule } from "../../src/config/schema"

const rule = (id: string, glob: string): Rule => ({
  id, glob, layer: "L", layerDescription: "d", severity: "warn", rule: "r", tools: [],
})

test("matches files by glob and drops rules with no matches", () => {
  const rules = [rule("ctrl", "src/controllers/**/*.ts"), rule("none", "src/nope/**")]
  const changed = ["src/controllers/user.ts", "src/services/user.ts"]
  const items = matchRules(changed, rules)
  expect(items).toHaveLength(1)
  expect(items[0]!.rule.id).toBe("ctrl")
  expect(items[0]!.matchedFiles).toEqual(["src/controllers/user.ts"])
})

test("a broad glob matches everything (global rule)", () => {
  const items: DispatchItem[] = matchRules(["a.ts", "b/c.ts"], [rule("g", "**/*.ts")])
  expect(items[0]!.matchedFiles).toEqual(["a.ts", "b/c.ts"])
})

test("returns empty when nothing matches", () => {
  expect(matchRules(["readme.md"], [rule("g", "**/*.ts")])).toEqual([])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/match/matcher.test.ts`
Expected: FAIL — cannot find module matcher.

- [ ] **Step 3: Write `src/match/matcher.ts`**

```ts
import picomatch from "picomatch"
import type { Rule } from "../config/schema"

export interface DispatchItem {
  rule: Rule
  matchedFiles: string[]
}

/** Pure, deterministic glob match of changed files against rules. */
export function matchRules(changedFiles: string[], rules: Rule[]): DispatchItem[] {
  const items: DispatchItem[] = []
  for (const rule of rules) {
    const isMatch = picomatch(rule.glob, { dot: true })
    const matchedFiles = changedFiles.filter((f) => isMatch(f))
    if (matchedFiles.length > 0) items.push({ rule, matchedFiles })
  }
  return items
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/match/matcher.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
bunx tsgo --noEmit
jj commit -m "feat: deterministic glob matcher"
```

---

## Task 5: Finding types + result store (cross-process JSONL)

**Files:**
- Create: `src/findings/types.ts`, `src/findings/store.ts`
- Test: `tests/findings/store.test.ts`

- [ ] **Step 1: Write `src/findings/types.ts`** (no test — pure type declarations)

```ts
import type { Severity } from "../config/schema"

export interface Finding {
  ruleId: string
  layer: string
  file: string
  line: number
  severity: Severity
  explanation: string
  confidence: number // 0..1
  suggestedFix?: string
}

export type RuleStatus = "clean" | "violations" | "errored"

/** One per dispatched rule — what the orchestrator recorded via the reporter tool. */
export interface RuleResult {
  ruleId: string
  status: RuleStatus
  findings: Finding[]
  reason?: string // populated when status === "errored"
}
```

- [ ] **Step 2: Write the failing test for the store**

```ts
// tests/findings/store.test.ts
import { test, expect } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendResult, readResults } from "../../src/findings/store"
import type { RuleResult } from "../../src/findings/types"

const path = () => join(mkdtempSync(join(tmpdir(), "store-")), "results.jsonl")

test("appends and reads results round-trip", () => {
  const p = path()
  const a: RuleResult = { ruleId: "a", status: "clean", findings: [] }
  const b: RuleResult = { ruleId: "b", status: "violations", findings: [
    { ruleId: "b", layer: "L", file: "x.ts", line: 1, severity: "error", explanation: "bad", confidence: 0.9 },
  ] }
  appendResult(p, a)
  appendResult(p, b)
  const all = readResults(p)
  expect(all.map((r) => r.ruleId)).toEqual(["a", "b"])
  expect(all[1]!.findings[0]!.severity).toBe("error")
})

test("readResults on missing file returns empty", () => {
  expect(readResults(path())).toEqual([])
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/findings/store.test.ts`
Expected: FAIL — cannot find module store.

- [ ] **Step 4: Write `src/findings/store.ts`**

```ts
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import type { RuleResult } from "./types"

/**
 * The result store is a JSONL file so it survives the process boundary between
 * our harness and the OpenCode server that runs the reporter tool. One line per
 * dispatched rule.
 */
export function appendResult(storePath: string, result: RuleResult): void {
  appendFileSync(storePath, JSON.stringify(result) + "\n", "utf8")
}

export function readResults(storePath: string): RuleResult[] {
  if (!existsSync(storePath)) return []
  return readFileSync(storePath, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as RuleResult)
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/findings/store.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Typecheck + commit**

```bash
bunx tsgo --noEmit
jj commit -m "feat: finding types and cross-process result store"
```

---

## Task 6: Deterministic gate

**Files:**
- Create: `src/gate/gate.ts`
- Test: `tests/gate/gate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/gate/gate.test.ts
import { test, expect } from "bun:test"
import { computeGate } from "../../src/gate/gate"
import type { RuleResult } from "../../src/findings/types"

const clean = (id: string): RuleResult => ({ ruleId: id, status: "clean", findings: [] })
const errored = (id: string): RuleResult => ({ ruleId: id, status: "errored", findings: [], reason: "timeout" })
const violation = (id: string, sev: "error" | "warn"): RuleResult => ({
  ruleId: id, status: "violations",
  findings: [{ ruleId: id, layer: "L", file: "x", line: 1, severity: sev, explanation: "e", confidence: 1 }],
})

test("passes when all dispatched rules are clean", () => {
  const g = computeGate([clean("a"), clean("b")], ["a", "b"], false)
  expect(g.passed).toBe(true)
})

test("fails when any error-severity finding exists", () => {
  const g = computeGate([violation("a", "error")], ["a"], false)
  expect(g.passed).toBe(false)
  expect(g.errorFindings).toBe(1)
})

test("warn-only findings do not fail the gate", () => {
  const g = computeGate([violation("a", "warn")], ["a"], false)
  expect(g.passed).toBe(true)
})

test("fail-closed: a dispatched rule with no recorded result fails", () => {
  const g = computeGate([clean("a")], ["a", "b"], false)
  expect(g.passed).toBe(false)
  expect(g.unevaluatedRuleIds).toEqual(["b"])
})

test("fail-closed: an errored rule fails", () => {
  const g = computeGate([errored("a")], ["a"], false)
  expect(g.passed).toBe(false)
})

test("fail-open: errored/unevaluated rules do not fail", () => {
  const g = computeGate([errored("a")], ["a", "b"], true)
  expect(g.passed).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/gate/gate.test.ts`
Expected: FAIL — cannot find module gate.

- [ ] **Step 3: Write `src/gate/gate.ts`**

```ts
import type { RuleResult } from "../findings/types"

export interface GateResult {
  passed: boolean
  errorFindings: number
  erroredRuleIds: string[]
  unevaluatedRuleIds: string[]
}

/**
 * The merge gate. Deterministic and independent of the model: even if the
 * orchestrator silently dropped a dispatched rule, that rule is "unevaluated"
 * and fails closed by default.
 */
export function computeGate(
  results: RuleResult[],
  dispatchedRuleIds: string[],
  failOpen: boolean,
): GateResult {
  const byId = new Map(results.map((r) => [r.ruleId, r]))

  const errorFindings = results
    .flatMap((r) => r.findings)
    .filter((f) => f.severity === "error").length

  const erroredRuleIds = results.filter((r) => r.status === "errored").map((r) => r.ruleId)
  const unevaluatedRuleIds = dispatchedRuleIds.filter((id) => !byId.has(id))

  const blockedByErrors = errorFindings > 0
  const blockedByMissing = !failOpen && (erroredRuleIds.length > 0 || unevaluatedRuleIds.length > 0)

  return {
    passed: !blockedByErrors && !blockedByMissing,
    errorFindings,
    erroredRuleIds,
    unevaluatedRuleIds,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/gate/gate.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
bunx tsgo --noEmit
jj commit -m "feat: deterministic merge gate over result store"
```

---

## Task 7: Summary renderer

**Files:**
- Create: `src/report/summary.ts`
- Test: `tests/report/summary.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/report/summary.test.ts
import { test, expect } from "bun:test"
import { renderSummaryMarkdown } from "../../src/report/summary"
import type { RuleResult } from "../../src/findings/types"

test("groups findings by layer and shows severity", () => {
  const results: RuleResult[] = [
    { ruleId: "no-db", status: "violations", findings: [
      { ruleId: "no-db", layer: "MVC", file: "src/services/u.ts", line: 12, severity: "error", explanation: "direct DB", confidence: 0.95 },
    ] },
    { ruleId: "ok", status: "clean", findings: [] },
  ]
  const md = renderSummaryMarkdown(results)
  expect(md).toContain("MVC")
  expect(md).toContain("src/services/u.ts:12")
  expect(md).toContain("direct DB")
})

test("renders a clean message when no findings", () => {
  expect(renderSummaryMarkdown([{ ruleId: "a", status: "clean", findings: [] }])).toContain("No violations")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/report/summary.test.ts`
Expected: FAIL — cannot find module summary.

- [ ] **Step 3: Write `src/report/summary.ts`**

```ts
import type { Finding, RuleResult } from "../findings/types"

export function renderSummaryMarkdown(results: RuleResult[]): string {
  const findings = results.flatMap((r) => r.findings)
  if (findings.length === 0) return "### Layered Review\n\nNo violations found. ✅\n"

  const byLayer = new Map<string, Finding[]>()
  for (const f of findings) {
    const list = byLayer.get(f.layer) ?? []
    list.push(f)
    byLayer.set(f.layer, list)
  }

  const lines = ["### Layered Review\n"]
  for (const [layer, list] of byLayer) {
    lines.push(`#### ${layer}`)
    for (const f of list) {
      const icon = f.severity === "error" ? "❌" : "⚠️"
      lines.push(`- ${icon} **${f.file}:${f.line}** (${f.ruleId}) — ${f.explanation}`)
    }
    lines.push("")
  }
  return lines.join("\n")
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/report/summary.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
bunx tsgo --noEmit
jj commit -m "feat: markdown summary renderer"
```

---

## Task 8: Local output writer

**Files:**
- Create: `src/report/local.ts`
- Test: `tests/report/local.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/report/local.test.ts
import { test, expect } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeLocalOutput } from "../../src/report/local"
import type { RuleResult } from "../../src/findings/types"

test("writes findings.json and summary.md under <epochMs>/", () => {
  const base = mkdtempSync(join(tmpdir(), "out-"))
  const results: RuleResult[] = [
    { ruleId: "r", status: "violations", findings: [
      { ruleId: "r", layer: "L", file: "a.ts", line: 3, severity: "warn", explanation: "x", confidence: 0.7 },
    ] },
  ]
  const dir = writeLocalOutput(results, base, 1733000000000)
  expect(dir).toBe(join(base, "1733000000000"))
  const findings = JSON.parse(readFileSync(join(dir, "findings.json"), "utf8"))
  expect(findings).toHaveLength(1)
  expect(findings[0].file).toBe("a.ts")
  expect(readFileSync(join(dir, "summary.md"), "utf8")).toContain("a.ts:3")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/report/local.test.ts`
Expected: FAIL — cannot find module local.

- [ ] **Step 3: Write `src/report/local.ts`**

```ts
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { RuleResult } from "../findings/types"
import { renderSummaryMarkdown } from "./summary"

/** Write a fresh timestamped run directory. Returns the directory path. */
export function writeLocalOutput(results: RuleResult[], baseDir: string, epochMs: number): string {
  const dir = join(baseDir, String(epochMs))
  mkdirSync(dir, { recursive: true })
  const findings = results.flatMap((r) => r.findings)
  writeFileSync(join(dir, "findings.json"), JSON.stringify(findings, null, 2), "utf8")
  writeFileSync(join(dir, "summary.md"), renderSummaryMarkdown(results), "utf8")
  return dir
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/report/local.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Typecheck + commit**

```bash
bunx tsgo --noEmit
jj commit -m "feat: local output writer (timestamped run dirs)"
```

---

## Task 9: GitHub reporter (dedup + inline comments)

**Files:**
- Create: `src/report/github.ts`
- Test: `tests/report/github.test.ts`

The reporter takes an injected `octokit`-shaped client so it is testable with a fake. Dedup is deterministic: a hidden marker `<!-- review-agent:{ruleId}:{fingerprint} -->` is embedded in each comment; existing comments carrying the same marker are skipped.

- [ ] **Step 1: Write the failing test**

```ts
// tests/report/github.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/report/github.test.ts`
Expected: FAIL — cannot find module github.

- [ ] **Step 3: Write `src/report/github.ts`**

```ts
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
  return createHash("sha1").update(`${f.file}:${f.line}:${f.explanation}`).digest("hex").slice(0, 12)
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/report/github.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
bunx tsgo --noEmit
jj commit -m "feat: github reporter with deterministic dedup"
```

---

## Task 10: Octokit adapter for GitHub source + ReviewClient

**Files:**
- Create: `src/source/types.ts`, `src/source/githubPr.ts`
- Test: `tests/source/types.test.ts`

`SourceResult` carries a per-file diff map; `changedFiles()` derives the file list. `GitHubPRSource` and the `ReviewClient` are constructed from a real octokit instance — those constructors are thin and validated by the live smoke test (Task 17), not unit tests. We unit-test only the pure `changedFiles` helper here.

- [ ] **Step 1: Write the failing test**

```ts
// tests/source/types.test.ts
import { test, expect } from "bun:test"
import { changedFiles, type SourceResult } from "../../src/source/types"

test("changedFiles derives keys from diffByFile", () => {
  const r: SourceResult = { diffByFile: { "a.ts": "@@", "b/c.ts": "@@" } }
  expect(changedFiles(r).sort()).toEqual(["a.ts", "b/c.ts"])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/source/types.test.ts`
Expected: FAIL — cannot find module types.

- [ ] **Step 3: Write `src/source/types.ts`**

```ts
export interface SourceResult {
  /** changed file path -> its unified-diff hunks for this PR/diff */
  diffByFile: Record<string, string>
}

export interface Source {
  read(): Promise<SourceResult>
}

export function changedFiles(result: SourceResult): string[] {
  return Object.keys(result.diffByFile)
}
```

- [ ] **Step 4: Write `src/source/githubPr.ts`** (no unit test — covered by live smoke test)

```ts
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
      octokit.paginate(octokit.pulls.listReviewComments, {
        owner: ctx.owner, repo: ctx.repo, pull_number: ctx.pull_number, per_page: 100,
      }),
    createReviewComment: async (body, file, line) => {
      await octokit.pulls.createReviewComment({
        owner: ctx.owner, repo: ctx.repo, pull_number: ctx.pull_number,
        commit_id: ctx.commit_id, body, path: file, line, side: "RIGHT",
      })
    },
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/source/types.test.ts`
Expected: PASS (1 test).

- [ ] **Step 6: Typecheck + commit**

```bash
bunx tsgo --noEmit
jj commit -m "feat: source types and github PR source"
```

---

## Task 11: Local git source

**Files:**
- Create: `src/source/localGit.ts`
- Test: `tests/source/localGit.test.ts`

The source shells out to `git`. We make the runner injectable so we can test parsing without a real repo.

- [ ] **Step 1: Write the failing test**

```ts
// tests/source/localGit.test.ts
import { test, expect } from "bun:test"
import { LocalGitSource } from "../../src/source/localGit"
import { changedFiles } from "../../src/source/types"

test("parses a multi-file unified diff into diffByFile", async () => {
  const fakeDiff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 111..222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,3 @@",
    "+const x = 1",
    "diff --git a/src/b.ts b/src/b.ts",
    "--- a/src/b.ts",
    "+++ b/src/b.ts",
    "@@ -0,0 +1 @@",
    "+export const y = 2",
  ].join("\n")
  const src = new LocalGitSource("main", async () => fakeDiff)
  const result = await src.read()
  expect(changedFiles(result).sort()).toEqual(["src/a.ts", "src/b.ts"])
  expect(result.diffByFile["src/a.ts"]!).toContain("+const x = 1")
  expect(result.diffByFile["src/b.ts"]!).toContain("+export const y = 2")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/source/localGit.test.ts`
Expected: FAIL — cannot find module localGit.

- [ ] **Step 3: Write `src/source/localGit.ts`**

```ts
import type { Source, SourceResult } from "./types"

export type DiffRunner = (base: string) => Promise<string>

const defaultRunner: DiffRunner = async (base) => {
  const proc = Bun.spawn(["git", "diff", "--unified=3", `${base}...HEAD`], { stdout: "pipe" })
  return await new Response(proc.stdout).text()
}

/** Splits `git diff` output into a per-file map keyed by the new path. */
export class LocalGitSource implements Source {
  constructor(private base: string, private runner: DiffRunner = defaultRunner) {}

  async read(): Promise<SourceResult> {
    const raw = await this.runner(this.base)
    const diffByFile: Record<string, string> = {}
    let currentFile: string | null = null
    let buffer: string[] = []

    const flush = () => {
      if (currentFile && buffer.length) diffByFile[currentFile] = buffer.join("\n")
      buffer = []
    }

    for (const line of raw.split("\n")) {
      const header = line.match(/^diff --git a\/.+ b\/(.+)$/)
      if (header) {
        flush()
        currentFile = header[1]!
      }
      if (currentFile) buffer.push(line)
    }
    flush()
    return { diffByFile }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/source/localGit.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Typecheck + commit**

```bash
bunx tsgo --noEmit
jj commit -m "feat: local git diff source"
```

---

## Task 12: Orchestrator prompt builder

**Files:**
- Create: `src/orchestrator/prompt.ts`
- Test: `tests/orchestrator/prompt.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/orchestrator/prompt.test.ts
import { test, expect } from "bun:test"
import { buildOrchestratorPrompt, buildSubagentTaskPrompt } from "../../src/orchestrator/prompt"
import type { DispatchItem } from "../../src/match/matcher"

import { reviewerAgentFor } from "../../src/orchestrator/prompt"

const item: DispatchItem = {
  rule: { id: "no-db", layer: "MVC", layerDescription: "services never touch DB", glob: "src/services/**", severity: "error", rule: "flag direct DB access", tools: [] },
  matchedFiles: ["src/services/u.ts"],
}

const sqlItem: DispatchItem = {
  rule: { id: "query-explain", layer: "SQL", layerDescription: "queries must be efficient", glob: "**/*.sql.ts", severity: "error", rule: "run sql_explain", tools: ["sql_explain"] },
  matchedFiles: ["src/q.sql.ts"],
}

test("orchestrator prompt lists every rule id and instructs one report per rule", () => {
  const p = buildOrchestratorPrompt([item])
  expect(p).toContain("no-db")
  expect(p).toContain("rule-reviewer")
  expect(p).toContain("report") // the reporter tool name
  expect(p).toContain("exactly once") // one report call per rule
})

test("orchestrator prompt names the specialized subagent for a custom-tooled rule", () => {
  const p = buildOrchestratorPrompt([sqlItem])
  expect(p).toContain("rule-reviewer-query-explain")
})

test("reviewerAgentFor picks generic vs specialized by tools", () => {
  expect(reviewerAgentFor(item.rule)).toBe("rule-reviewer")
  expect(reviewerAgentFor(sqlItem.rule)).toBe("rule-reviewer-query-explain")
})

test("subagent task prompt includes rule prose, layer context, files, the diff, and tools", () => {
  const p = buildSubagentTaskPrompt(sqlItem, { "src/q.sql.ts": "@@ +SELECT *" })
  expect(p).toContain("queries must be efficient")
  expect(p).toContain("run sql_explain")
  expect(p).toContain("src/q.sql.ts")
  expect(p).toContain("SELECT *")
  expect(p).toContain("sql_explain") // available tools surfaced to the subagent
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/orchestrator/prompt.test.ts`
Expected: FAIL — cannot find module prompt.

- [ ] **Step 3: Write `src/orchestrator/prompt.ts`**

```ts
import type { DispatchItem } from "../match/matcher"
import type { Rule } from "../config/schema"

export const REPORTER_TOOL = "report"
export const REVIEWER_AGENT = "rule-reviewer"

/** Generic reviewer for plain rules; a specialized one for custom-tooled rules. */
export function reviewerAgentFor(rule: Rule): string {
  return rule.tools.length > 0 ? `${REVIEWER_AGENT}-${rule.id}` : REVIEWER_AGENT
}

/** The opening prompt for the orchestrator primary agent. */
export function buildOrchestratorPrompt(items: DispatchItem[]): string {
  const list = items
    .map((i) => `- ${i.rule.id} (layer "${i.rule.layer}", severity ${i.rule.severity}) — subagent: ${reviewerAgentFor(i.rule)}, files: ${i.matchedFiles.join(", ")}`)
    .join("\n")
  return [
    "You are the orchestrator for a layered PR review. You will enforce the rules below.",
    "",
    "For EACH rule:",
    `1. Dispatch the rule's subagent (named in the list below) via the task tool with the rule's review prompt.`,
    "2. Read the findings the subagent returns (a JSON array in its final message).",
    "3. Drop any finding with confidence below 0.6 (likely false positive).",
    `4. Call the "${REPORTER_TOOL}" tool EXACTLY ONCE for that rule, with status`,
    '   "violations" (and the surviving findings), "clean" (no findings), or',
    '   "errored" (the subagent failed). Never skip a rule.',
    "",
    "You are the ONLY agent permitted to call the reporter tool. Subagents cannot report.",
    "",
    `Rules to enforce (${items.length}):`,
    list,
    "",
    "The exact review prompt for each subagent is supplied when you dispatch it.",
  ].join("\n")
}

/** Per-rule task prompt handed to a rule-reviewer subagent. */
export function buildSubagentTaskPrompt(item: DispatchItem, diffByFile: Record<string, string>): string {
  const diffs = item.matchedFiles
    .map((f) => `### ${f}\n\`\`\`diff\n${diffByFile[f] ?? "(no diff)"}\n\`\`\``)
    .join("\n\n")
  return [
    `You are reviewing changed code against ONE rule. Judge the NEW code on its own merits.`,
    `Do NOT excuse a violation because similar patterns already exist in the codebase.`,
    "",
    `Layer: ${item.rule.layer}`,
    `Layer context: ${item.rule.layerDescription}`,
    `Rule (${item.rule.id}, severity ${item.rule.severity}): ${item.rule.rule}`,
    "",
    `You may read any file in the repo for context (read-only).`,
    item.rule.tools.length > 0
      ? `You also have these validation tools available — use them as the rule requires: ${item.rule.tools.join(", ")}.`
      : "",
    "",
    `Changed files and their diffs:`,
    diffs,
    "",
    `Respond with ONLY a JSON array of findings (may be empty). Each finding:`,
    `{ "ruleId": "${item.rule.id}", "layer": "${item.rule.layer}", "file": string,`,
    `  "line": number, "severity": "${item.rule.severity}", "explanation": string,`,
    `  "confidence": number (0..1), "suggestedFix"?: string }`,
  ].join("\n")
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/orchestrator/prompt.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
bunx tsgo --noEmit
jj commit -m "feat: orchestrator and subagent prompt builders"
```

---

## Task 13: OpenCode agent config

**Files:**
- Create: `src/opencode/agents.ts`
- Test: `tests/opencode/agents.test.ts`

This builds the config object passed to `createOpencode({ config })`: a `primary` orchestrator that may call the reporter tool + the task tool, the generic read-only `rule-reviewer`, and one specialized `rule-reviewer-{id}` per rule that declares custom `tools` (granted exactly those tools, still denied the reporter). The reporter-tool/agent names come from `prompt.ts` (single source of truth).

- [ ] **Step 1: Write the failing test**

```ts
// tests/opencode/agents.test.ts
import { test, expect } from "bun:test"
import { buildAgentConfig } from "../../src/opencode/agents"
import { REPORTER_TOOL, REVIEWER_AGENT } from "../../src/orchestrator/prompt"
import type { Rule } from "../../src/config/schema"

const rule = (id: string, tools: string[]): Rule => ({
  id, glob: "*", layer: "L", layerDescription: "d", severity: "warn", rule: "r", tools,
})

test("orchestrator may report; generic subagent is denied the reporter tool and edits", () => {
  const cfg = buildAgentConfig("anthropic/claude-sonnet-4-5", [rule("a", [])])
  const orch = cfg.agent.orchestrator
  const rev = cfg.agent[REVIEWER_AGENT]!
  expect(orch.mode).toBe("primary")
  expect(orch.permission[REPORTER_TOOL]).toBe("allow")
  expect(orch.permission.task).toBe("allow")
  expect(rev.mode).toBe("subagent")
  expect(rev.permission[REPORTER_TOOL]).toBe("deny")
  expect(rev.permission.edit).toBe("deny")
  expect(rev.permission.bash).toBe("deny")
})

test("a custom-tooled rule gets a specialized subagent granting exactly its tools, reporter still denied", () => {
  const cfg = buildAgentConfig("anthropic/claude-sonnet-4-5", [rule("query-explain", ["sql_explain"])])
  const spec = cfg.agent["rule-reviewer-query-explain"]!
  expect(spec.mode).toBe("subagent")
  expect(spec.permission["sql_explain"]).toBe("allow")
  expect(spec.permission[REPORTER_TOOL]).toBe("deny")
  expect(spec.permission.edit).toBe("deny")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/opencode/agents.test.ts`
Expected: FAIL — cannot find module agents.

- [ ] **Step 3: Write `src/opencode/agents.ts`**

```ts
import { REPORTER_TOOL, REVIEWER_AGENT, reviewerAgentFor } from "../orchestrator/prompt"
import type { Rule } from "../config/schema"

type Action = "allow" | "ask" | "deny"
interface AgentDef {
  mode: "primary" | "subagent"
  model: string
  description: string
  permission: Record<string, Action>
}
export interface AgentConfig {
  agent: { orchestrator: AgentDef } & Record<string, AgentDef>
}

/** Read-only base permissions shared by every reviewer; reporter always denied. */
function reviewerBasePermissions(): Record<string, Action> {
  return {
    [REPORTER_TOOL]: "deny",
    task: "deny",
    read: "allow",
    glob: "allow",
    grep: "allow",
    edit: "deny",
    bash: "deny",
  }
}

/**
 * Config object for createOpencode({ config }). Enforces the reporter guarantee
 * and grants each custom-tooled rule a specialized read-only reviewer.
 */
export function buildAgentConfig(model: string, rules: Rule[]): AgentConfig {
  const agent: AgentConfig["agent"] = {
    orchestrator: {
      mode: "primary",
      model,
      description: "Layered PR review orchestrator",
      permission: {
        [REPORTER_TOOL]: "allow",
        task: "allow",
        read: "allow",
        glob: "allow",
        grep: "allow",
        edit: "deny",
        bash: "deny",
      },
    },
    [REVIEWER_AGENT]: {
      mode: "subagent",
      model,
      description: "Reviews changed code against a single rule (read-only)",
      permission: reviewerBasePermissions(),
    },
  }

  for (const rule of rules) {
    if (rule.tools.length === 0) continue
    const permission = reviewerBasePermissions()
    for (const t of rule.tools) {
      if (t === REPORTER_TOOL) continue // reporter is never grantable to a subagent
      permission[t] = "allow"
    }
    agent[reviewerAgentFor(rule)] = {
      mode: "subagent",
      model,
      description: `Reviews rule ${rule.id} with tools: ${rule.tools.join(", ")} (read-only)`,
      permission,
    }
  }

  return { agent }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/opencode/agents.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Typecheck + commit**

```bash
bunx tsgo --noEmit
jj commit -m "feat: opencode agent config with reporter permission split"
```

---

## Task 14: The reporter tool (`.opencode/tool/report.ts`)

**Files:**
- Create: `.opencode/tool/report.ts`

This is a thin OpenCode custom tool. All logic lives in `src/` (already tested). It reads the store path from `REVIEW_STORE_PATH`, the mode from `REVIEW_MODE` (`github`|`local`), and GitHub context from env. For `github` it posts via the reporter; for both it appends a `RuleResult` to the store. No unit test — exercised by Task 16 (integration) and Task 17 (live smoke).

- [ ] **Step 1: Write `.opencode/tool/report.ts`**

```ts
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
```

- [ ] **Step 2: Typecheck + commit**

```bash
bunx tsgo --noEmit
jj commit -m "feat: reporter tool (thin wrapper over store + github reporter)"
```

---

## Task 15: Orchestrator runner (SDK bootstrap)

**Files:**
- Create: `src/orchestrator/run.ts`
- Test: `tests/orchestrator/run.test.ts`

`runOrchestrator` is injected with a `PromptClient` (the subset of the SDK we use) so it is testable with a fake. It sets the store-path env, builds the prompt, runs the session, and returns nothing — results live in the store file.

- [ ] **Step 1: Write the failing test**

```ts
// tests/orchestrator/run.test.ts
import { test, expect } from "bun:test"
import { runOrchestrator, type PromptClient } from "../../src/orchestrator/run"
import type { DispatchItem } from "../../src/match/matcher"

const item: DispatchItem = {
  rule: { id: "r", layer: "L", layerDescription: "d", glob: "**", severity: "warn", rule: "x", tools: [] },
  matchedFiles: ["a.ts"],
}

test("creates a session and prompts the orchestrator agent with the dispatch list", async () => {
  const calls: { agent?: string; text: string }[] = []
  const client: PromptClient = {
    createSession: async () => ({ id: "s1" }),
    prompt: async (sessionId, agent, text) => { calls.push({ agent, text }); return { text: "done" } },
  }
  await runOrchestrator(client, { items: item ? [item] : [], diffByFile: { "a.ts": "@@" } })
  expect(calls).toHaveLength(1)
  expect(calls[0]!.agent).toBe("orchestrator")
  expect(calls[0]!.text).toContain("r")
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/orchestrator/run.test.ts`
Expected: FAIL — cannot find module run.

- [ ] **Step 3: Write `src/orchestrator/run.ts`**

```ts
import type { DispatchItem } from "../match/matcher"
import { buildOrchestratorPrompt, buildSubagentTaskPrompt } from "./prompt"

export interface PromptClient {
  createSession(): Promise<{ id: string }>
  prompt(sessionId: string, agent: string, text: string): Promise<{ text: string }>
}

export interface RunOptions {
  items: DispatchItem[]
  diffByFile: Record<string, string>
}

/**
 * Drives the orchestrator session. The orchestrator LLM does the fan-out via the
 * task tool and posting via the reporter tool; we just give it the dispatch list
 * plus, appended, each rule's ready-to-use subagent task prompt.
 */
export async function runOrchestrator(client: PromptClient, opts: RunOptions): Promise<void> {
  const session = await client.createSession()
  const taskPrompts = opts.items
    .map((i) => `=== task prompt for rule ${i.rule.id} ===\n${buildSubagentTaskPrompt(i, opts.diffByFile)}`)
    .join("\n\n")
  const prompt = `${buildOrchestratorPrompt(opts.items)}\n\n${taskPrompts}`
  await client.prompt(session.id, "orchestrator", prompt)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/orchestrator/run.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Typecheck + commit**

```bash
bunx tsgo --noEmit
jj commit -m "feat: orchestrator SDK runner"
```

---

## Task 16: End-to-end harness against a fake SDK client

**Files:**
- Create: `src/orchestrator/harness.ts`
- Test: `tests/orchestrator/harness.test.ts`

`runReview` glues the deterministic pieces: match → run orchestrator → read store → compute gate. It takes already-loaded `rules` (the entrypoint loads them once and reuses them to build the agent config). The `PromptClient` and `Source` are injected, so this whole path is deterministically testable. The fake client simulates the orchestrator by writing `RuleResult`s to the store (proving the cross-process contract).

- [ ] **Step 1: Write the failing test**

```ts
// tests/orchestrator/harness.test.ts
import { test, expect } from "bun:test"
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runReview } from "../../src/orchestrator/harness"
import { loadRules } from "../../src/config/loader"
import { appendResult } from "../../src/findings/store"
import type { PromptClient } from "../../src/orchestrator/run"
import type { Source } from "../../src/source/types"

function rulesFrom(name: string, body: string) {
  const reviews = join(mkdtempSync(join(tmpdir(), "rev-")), ".reviews")
  mkdirSync(reviews)
  writeFileSync(join(reviews, name), body)
  return loadRules(reviews)
}

test("full path: match → orchestrate → gate fails on an error finding", async () => {
  const rules = rulesFrom("mvc.yaml",
    `layer: MVC\ndescription: services never touch DB\nrules:\n  - id: no-db\n    glob: "src/services/**"\n    severity: error\n    rule: flag direct DB access\n`)

  const storePath = join(mkdtempSync(join(tmpdir(), "store-")), "results.jsonl")
  const source: Source = { read: async () => ({ diffByFile: { "src/services/u.ts": "@@ +db.query()" } }) }

  // Fake orchestrator: writes the result the real LLM+tool would write.
  const client: PromptClient = {
    createSession: async () => ({ id: "s" }),
    prompt: async () => {
      appendResult(storePath, { ruleId: "no-db", status: "violations", findings: [
        { ruleId: "no-db", layer: "MVC", file: "src/services/u.ts", line: 1, severity: "error", explanation: "direct DB", confidence: 0.95 },
      ] })
      return { text: "done" }
    },
  }

  const gate = await runReview({ rules, source, client, storePath, failOpen: false })
  expect(gate.passed).toBe(false)
  expect(gate.errorFindings).toBe(1)
})

test("gate fails closed when orchestrator records nothing for a dispatched rule", async () => {
  const rules = rulesFrom("g.yaml",
    `layer: G\ndescription: d\nrules:\n  - id: g\n    glob: "**/*.ts"\n    severity: warn\n    rule: x\n`)
  const storePath = join(mkdtempSync(join(tmpdir(), "store-")), "results.jsonl")
  const source: Source = { read: async () => ({ diffByFile: { "a.ts": "@@" } }) }
  const client: PromptClient = { createSession: async () => ({ id: "s" }), prompt: async () => ({ text: "done" }) }

  const gate = await runReview({ rules, source, client, storePath, failOpen: false })
  expect(gate.passed).toBe(false)
  expect(gate.unevaluatedRuleIds).toEqual(["g"])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/orchestrator/harness.test.ts`
Expected: FAIL — cannot find module harness.

- [ ] **Step 3: Write `src/orchestrator/harness.ts`**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/orchestrator/harness.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
bunx tsgo --noEmit
jj commit -m "feat: end-to-end review harness with deterministic gate"
```

---

## Task 17: SDK client adapter + CLI entrypoint (local)

**Files:**
- Create: `src/orchestrator/sdkClient.ts`, `src/entrypoints/cli.ts`

Wires the real `@opencode-ai/sdk` into the `PromptClient` shape and runs the local flow. The SDK adapter is validated by the live smoke test (Task 19), not a unit test.

- [ ] **Step 1: Write `src/orchestrator/sdkClient.ts`**

```ts
import { createOpencode } from "@opencode-ai/sdk"
import type { PromptClient } from "./run"
import { buildAgentConfig } from "../opencode/agents"
import type { Rule } from "../config/schema"

export interface SdkHandle {
  client: PromptClient
  close: () => Promise<void>
}

/** Boot an embedded OpenCode server and adapt its client to PromptClient. */
export async function createSdkClient(model: string, rules: Rule[]): Promise<SdkHandle> {
  const { client, server } = await createOpencode({ config: buildAgentConfig(model, rules) })
  return {
    client: {
      createSession: async () => {
        const s = await client.session.create({ body: { title: "layered-review" } })
        return { id: s.id }
      },
      prompt: async (sessionId, agent, text) => {
        const r = await client.session.prompt({
          path: { id: sessionId },
          body: { agent, parts: [{ type: "text", text }] },
        })
        return { text: JSON.stringify(r.data ?? {}) }
      },
    },
    close: async () => { await server.close() },
  }
}
```

- [ ] **Step 2: Write `src/entrypoints/cli.ts`**

```ts
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

main().catch((e) => { console.error(e); process.exit(2) })
```

- [ ] **Step 3: Typecheck + commit**

```bash
bunx tsgo --noEmit
jj commit -m "feat: SDK client adapter and local CLI entrypoint"
```

---

## Task 18: GitHub Action entrypoint + workflow

**Files:**
- Create: `src/entrypoints/action.ts`, `.github/workflows/layered-review.yml`

- [ ] **Step 1: Write `src/entrypoints/action.ts`**

```ts
import { join } from "node:path"
import { Octokit } from "@octokit/rest"
import { runReview } from "../orchestrator/harness"
import { createSdkClient } from "../orchestrator/sdkClient"
import { loadRules } from "../config/loader"
import { GitHubPRSource } from "../source/githubPr"
import type { GithubCtx } from "../report/github"

async function main() {
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? "/").split("/")
  const pull_number = Number(process.env.PR_NUMBER)
  const commit_id = process.env.PR_HEAD_SHA!
  const ctx: GithubCtx = { owner: owner!, repo: repo!, pull_number, commit_id }
  const model = process.env.REVIEW_MODEL ?? "anthropic/claude-sonnet-4-5"
  const storePath = join(process.env.RUNNER_TEMP ?? ".", `review-store-${pull_number}.jsonl`)

  // Reporter tool reads these.
  process.env.REVIEW_MODE = "github"
  process.env.REVIEW_STORE_PATH = storePath
  process.env.REVIEW_GH_OWNER = owner
  process.env.REVIEW_GH_REPO = repo
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
      failOpen: process.env.REVIEW_FAIL_OPEN === "true",
    })
    await octokit.repos.createCommitStatus({
      owner: owner!, repo: repo!, sha: commit_id,
      state: gate.passed ? "success" : "failure",
      context: "layered-review",
      description: gate.passed ? "No blocking violations" : `${gate.errorFindings} error(s)`,
    })
    process.exit(gate.passed ? 0 : 1)
  } finally {
    await sdk.close()
  }
}

main().catch((e) => { console.error(e); process.exit(2) })
```

- [ ] **Step 2: Write `.github/workflows/layered-review.yml`**

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
      - run: bun run src/entrypoints/action.ts
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GITHUB_REPOSITORY: ${{ github.repository }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
          PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}
```

- [ ] **Step 3: Typecheck + commit**

```bash
bunx tsgo --noEmit
jj commit -m "feat: github action entrypoint and workflow"
```

---

## Task 19: Demo fixture + live smoke test

**Files:**
- Create: `examples/demo/.reviews/mvc.yaml`, `examples/demo/.reviews/neverthrow.yaml`, `examples/demo/.reviews/sql.yaml`, `examples/demo/.opencode/tool/sql_explain.ts` (custom tool), `examples/demo/src/services/billing.ts` + `examples/demo/src/queries/customers.sql.ts` (planted violations), `examples/demo/README.md`

This is a manual/live validation, not an automated test — it exercises the real OpenCode SDK + Anthropic model end-to-end, including a custom reviewer tool.

- [ ] **Step 1: Write demo rules**

`examples/demo/.reviews/mvc.yaml`:
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

`examples/demo/.reviews/neverthrow.yaml`:
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

`examples/demo/.reviews/sql.yaml` (a layer whose reviewer uses a custom tool):
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

`examples/demo/.opencode/tool/sql_explain.ts` (custom reviewer tool — read-only `EXPLAIN`, never the reporter):
```ts
import { tool } from "@opencode-ai/plugin"

export default tool({
  description: "Run EXPLAIN on a SQL query against the dev database and return the plan.",
  args: { query: tool.schema.string().describe("The SQL query to explain") },
  async execute(args) {
    // Demo stub: a real tool would connect to DEV_DATABASE_URL and run EXPLAIN.
    // Returns a plan string the reviewer subagent inspects for "Seq Scan".
    const proc = Bun.spawn(["psql", process.env.DEV_DATABASE_URL ?? "", "-c", `EXPLAIN ${args.query}`], { stdout: "pipe", stderr: "pipe" })
    const out = await new Response(proc.stdout).text()
    const err = await new Response(proc.stderr).text()
    return out || `EXPLAIN failed: ${err}`
  },
})
```

- [ ] **Step 2: Write files with planted violations**

`examples/demo/src/services/billing.ts`:
```ts
import { db } from "../db"

export async function chargeCustomer(id: string): Promise<number> {
  try {
    const row = await db.query("SELECT balance FROM customers WHERE id = $1", [id]) // service-no-db violation
    return row.balance
  } catch (e) {
    throw new Error("charge failed") // no-try-catch violation
  }
}
```

`examples/demo/src/queries/customers.sql.ts` (exercises the `sql_explain` custom tool):
```ts
// A query with no index on `email` — sql_explain should report a Seq Scan.
export const findByEmail = `SELECT * FROM customers WHERE email = $1`
```

- [ ] **Step 3: Run the local CLI against the demo**

```bash
export ANTHROPIC_API_KEY=...   # required
cd examples/demo
git init && git add -A && git commit -m "base"   # establish a base to diff against
# edit billing.ts to introduce the violations, then:
bun run ../../src/entrypoints/cli.ts main
```

Expected: exits non-zero (FAIL); newest `.review-output/<epoch-ms>/findings.json` contains a `service-no-db` error finding on the `db.query` line and a `no-try-catch` warn finding.

- [ ] **Step 4: Verify subagents cannot report**

Confirm the run still posts/records only via the orchestrator: inspect `.review-output/<epoch-ms>/findings.json` and confirm every finding's `ruleId` corresponds to a dispatched rule, and that removing the orchestrator's `report` permission (temporarily, in `agents.ts`) causes zero findings to be recorded — proving the reporter path is orchestrator-only.

- [ ] **Step 5: Write `examples/demo/README.md`** documenting how to run the demo (the commands above) and commit.

```bash
jj commit -m "test: demo fixtures and live smoke validation"
```

---

## Task 20: README + finalize

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Write `README.md`** covering: what the tool does, the `.reviews/*.yaml` schema (with the MVC + neverthrow examples), local usage (`review <base>` + `.review-output/`), GitHub Action setup (`ANTHROPIC_API_KEY` secret, the workflow), the orchestrator/subagent/reporter architecture, and the fail-closed gate behavior.

- [ ] **Step 2: Full test + typecheck pass**

Run: `bun test && bunx tsgo --noEmit`
Expected: all tests PASS, no type errors.

- [ ] **Step 3: Commit + move bookmark**

```bash
jj commit -m "docs: project README"
jj bookmark set main -r @-
```

---

## Self-Review Notes (for the planner)

- **Spec coverage:** config schema (incl. `tools`) → T2/T3; matcher (deterministic, code) → T4; per-rule subagent + read-only → T12/T13/T19; custom reviewer tools (e.g. `sql_explain`) + specialized subagents → T2/T3 (schema+merge), T12 (`reviewerAgentFor` + prompt), T13 (specialized agent gen, reporter never granted), T19 (live demo tool); orchestrator validate+post → T12 (confidence drop), T14/T15; reporter tools + permission split → T13/T14; deterministic gate + fail-closed → T6/T16; GitHub dedup marker → T9; local `.review-output/<epoch-ms>/` → T8/T17; both entrypoints → T17/T18; SDK bootstrap → T15/T17; error handling (bad config, errored/unevaluated rule) → T3/T6/T16; demo (impure service, try/catch, SQL seq-scan) → T19. Partner-interface layer is covered implicitly by the schema (same shape as MVC); not separately fixtured — acceptable, the mechanism is identical.
- **Type consistency:** `Rule` (now with `tools: string[]`), `Finding`, `RuleResult`, `DispatchItem`, `GateResult`, `SourceResult`, `PromptClient`, and the `REPORTER_TOOL`/`REVIEWER_AGENT` constants + `reviewerAgentFor()` are defined once and reused across tasks; reporter-tool/agent names flow from `prompt.ts` into `agents.ts` and the reporter tool. `runReview` takes pre-loaded `rules` (loaded once per entrypoint, shared with `buildAgentConfig`) — no double load.
- **Known integration risks (validated live in T19, per research):** the SDK request field may be `format` vs `outputFormat` and the subagent-result accessor `structured` vs `structured_output` — but this plan parses subagent output as text JSON (not json_schema mode), so that risk does not apply here; the relevant risk is the `session.prompt` response shape used in `sdkClient.ts`, pinned during T17/T19 against the installed SDK's generated types.
