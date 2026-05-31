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
