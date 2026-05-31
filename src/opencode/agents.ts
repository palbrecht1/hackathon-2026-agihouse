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
