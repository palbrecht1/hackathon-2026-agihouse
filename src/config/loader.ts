import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parse as parseYaml } from "yaml"
import { LayerFileSchema, type Rule } from "./schema"

/**
 * Discover `.reviews/*.yaml`, validate, and flatten into a deduped Rule[].
 * A missing `.reviews/` directory means the repo has opted out of layered review:
 * return no rules (a no-op pass), rather than crashing.
 */
export function loadRules(reviewsDir: string): Rule[] {
  if (!existsSync(reviewsDir)) return []
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
