# 🐝 Code Review Swarm

**Multi-agent orchestrated code review with adversarial debate and W&B Weave tracing.**

> Built for the AGI House × W&B Multi-Agent Orchestration Build Day, May 2026.

## What It Does

Paste a code diff → 4 specialist AI agents review it **in parallel** → they **debate** each other's findings → a **Lead agent** consolidates into a final ranked review with a risk score.

```
┌─────────────────────────────────────────────────────┐
│                  CODE DIFF INPUT                      │
└──────────────────────┬──────────────────────────────┘
                       │
         ┌─────────────┼─────────────┐
         │             │             │
    ┌────▼────┐  ┌────▼────┐  ┌────▼────┐  ┌─────────┐
    │🔒Security│  │⚡ Perf  │  │🧠 Logic │  │🎨 Style │
    └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘
         │             │             │             │
         └─────────────┼─────────────┘─────────────┘
                       │
              ┌────────▼────────┐
              │  DEBATE ROUND   │  ← Agents challenge each other
              │  (adversarial)  │
              └────────┬────────┘
                       │
              ┌────────▼────────┐
              │  LEAD AGENT     │  ← Deduplicates, ranks, scores
              │  (consolidate)  │
              └────────┬────────┘
                       │
              ┌────────▼────────┐
              │  FINAL REVIEW   │  → Risk score 0-10
              │  + Weave Trace  │  → Full orchestration visible
              └─────────────────┘
```

## Architecture

| Phase | Agents | What Happens |
|-------|--------|--------------|
| 1. Parallel Review | Security, Performance, Logic, Style | Each specialist runs independently on the same diff |
| 2. Adversarial Debate | All specialists + Moderator | Each agent sees others' findings and can challenge false positives |
| 3. Lead Consolidation | Lead Engineer | Deduplicates, ranks by severity × confidence, produces final score |

**Multi-agent orchestration patterns used:**
- Parallel execution (Phase 1)
- Adversarial/critic loops (Phase 2)
- Hierarchical consolidation (Phase 3)
- All traced as nested Weave operations

## Quick Start

### 1. Install

```bash
cd /path/to/this/repo
python -m venv .venv
source .venv/bin/activate
pip install -e .
```

### 2. Set Environment Variables

```bash
export ANTHROPIC_API_KEY="your-anthropic-key"
export WANDB_API_KEY="your-wandb-key"
export WEAVE_PROJECT="your-team/code-review-swarm"
```

Or copy `.env.example` to `.env` and fill in values.

### 3. Run the Demo

```bash
# Default killer demo — reviews real Daytona.io workspace manager code
review-swarm demo

# List all demo scenarios
review-swarm demo --list-scenarios

# Run a specific scenario
review-swarm demo -s daytona-sandbox-api
review-swarm demo -s daytona-sdk-auth
review-swarm demo -s daytona-workspace   # (default — has SQL injection + cmd injection + N+1)
review-swarm demo -s basic               # synthetic examples
```

### 4. Review a Real GitHub PR

```bash
# By URL
review-swarm github https://github.com/daytonaio/daytona/pull/4822

# By shorthand
review-swarm github daytonaio/daytona#4858
```

### 5. Review Your Own Code

```bash
# From a file
review-swarm review -f path/to/diff.patch

# From git diff via stdin
git diff | review-swarm review --stdin

# From git diff of staged changes
git diff --cached | review-swarm review --stdin

# Review a GitHub PR directly
review-swarm review -g daytonaio/daytona#4858
```

### 6. Run the Evaluation Suite

```bash
# Runs against 8 labeled known-buggy diffs, scores precision/recall
review-swarm evaluate
```

## Usage Examples

### Review a PR diff
```bash
# Get a PR diff and pipe it in
gh pr diff 42 | review-swarm review -s
```

### Review with Weave tracing
```bash
# Explicit project
review-swarm review --demo -p "my-team/hackathon-demo"

# Or set WEAVE_PROJECT env var
export WEAVE_PROJECT="my-team/hackathon-demo"
review-swarm demo
```

### View traces in Weave
After running, open the link printed in the terminal to see:
- The full agent orchestration graph
- Each specialist's findings as nested traces
- The debate round with challenges and verdicts
- Token usage and latency per agent
- The final consolidated review

## What Gets Traced in Weave

Every operation is decorated with `@weave.op()`, so you get:

| Trace | What It Shows |
|-------|---------------|
| `review_diff` | Top-level orchestration — the full pipeline |
| `run_specialist_agent` (×4) | Each specialist's input/output, tokens, latency |
| `run_debate_round` | Challenges raised, verdicts, false positives caught |
| `run_lead_consolidation` | Final deduplication and ranking logic |
| `run_evaluation` | Eval metrics: recall, precision, severity accuracy |

## Evaluation Metrics

The eval suite tests against 8 known-buggy code samples:

| Metric | What It Measures |
|--------|-----------------|
| **Category Recall** | Did the swarm find the right type of bug? |
| **Severity Accuracy** | Did it rate the severity correctly? |
| **Precision** | What fraction of findings are actually relevant? |
| **Detection Rate** | Did it find *anything* at all? |

## Demo Script (for the hackathon presentation)

1. **Show the architecture** — explain the 3-phase pipeline (30 sec)
2. **Run `review-swarm demo`** — reviews real Daytona.io code, watch the orchestration tree with findings (60 sec)
3. **Open Weave** — show the trace graph with all 6 agents visible as nested operations (30 sec)
4. **Run `review-swarm github daytonaio/daytona#4858`** — live review of a real merged PR (30 sec)
5. **Run `review-swarm evaluate`** — show precision/recall metrics against labeled dataset (30 sec)

**Key talking points:**
- "4 specialist agents run in parallel — security, performance, logic, style"
- "Then they DEBATE each other — challenge false positives adversarially"
- "The lead agent consolidates after debate, only upheld findings survive"
- "Every step is traced in Weave — you can see the full orchestration graph"
- "We measured precision/recall against 8 known-buggy samples"

## Tech Stack

- **Anthropic Claude** (claude-sonnet-4-20250514) — powers all agents
- **W&B Weave** — tracing, evaluation, agent observability
- **Python asyncio** — parallel agent execution
- **Rich** — beautiful terminal UI for the demo
- **Pydantic** — structured data models for findings

## Project Structure

```
review_swarm/
├── __init__.py         # Package init
├── models.py           # Pydantic data models (Finding, Review, etc.)
├── prompts.py          # System prompts for each specialist agent
├── agents.py           # Core orchestration engine (parallel → debate → lead)
├── demos.py            # Curated real-world diffs from Daytona.io
├── github.py           # GitHub PR diff fetcher (any public repo)
├── evaluation.py       # Eval harness with labeled dataset + Weave scoring
├── ui.py               # Rich terminal rendering
└── cli.py              # Click CLI entry point
```

## Judging Criteria Alignment

| Criterion | How We Address It |
|-----------|-------------------|
| **Agent Orchestration** | 4 parallel specialists → adversarial debate → lead consolidation. Clear multi-agent handoffs. |
| **Utility** | Solves real code review — finds security vulns, perf issues, logic bugs, style problems. |
| **Technical Execution** | Async parallel execution, structured outputs, proper error handling, eval metrics. |
| **Creativity** | Adversarial debate between agents is novel — they challenge each other's false positives. |
| **Sponsor Usage** | Deep Weave integration: every agent traced, eval metrics logged, orchestration graph visible. |
