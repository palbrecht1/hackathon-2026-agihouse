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
