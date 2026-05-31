import { test, expect } from "bun:test"
import { changedFiles, type SourceResult } from "../../src/source/types"

test("changedFiles derives keys from diffByFile", () => {
  const r: SourceResult = { diffByFile: { "a.ts": "@@", "b/c.ts": "@@" } }
  expect(changedFiles(r).sort()).toEqual(["a.ts", "b/c.ts"])
})
