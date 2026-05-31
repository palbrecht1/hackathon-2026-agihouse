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

test("returns empty when the .reviews directory does not exist (no-op pass)", () => {
  const missing = join(mkdtempSync(join(tmpdir(), "no-reviews-")), ".reviews")
  expect(loadRules(missing)).toEqual([])
})
