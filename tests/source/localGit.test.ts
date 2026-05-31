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
