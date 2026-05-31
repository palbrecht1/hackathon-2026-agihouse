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
    `4. Call the "${REPORTER_TOOL}" tool exactly once for that rule, with status`,
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
