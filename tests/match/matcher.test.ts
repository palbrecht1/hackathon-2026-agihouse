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
