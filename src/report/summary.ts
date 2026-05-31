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
