"""Core agent engine — runs specialist agents in parallel and orchestrates the review."""

from __future__ import annotations

import asyncio
import json
import os
import time
from typing import Any

import weave

from .models import (
    AgentReview,
    Challenge,
    DebateRound,
    FinalReview,
    Finding,
    ReviewCategory,
    Severity,
)
from .prompts import (
    DEBATE_SYSTEM_PROMPT,
    LEAD_SYSTEM_PROMPT,
    LOGIC_SYSTEM_PROMPT,
    PERFORMANCE_SYSTEM_PROMPT,
    SECURITY_SYSTEM_PROMPT,
    STYLE_SYSTEM_PROMPT,
)

AGENT_PROMPTS = {
    ReviewCategory.SECURITY: SECURITY_SYSTEM_PROMPT,
    ReviewCategory.PERFORMANCE: PERFORMANCE_SYSTEM_PROMPT,
    ReviewCategory.LOGIC: LOGIC_SYSTEM_PROMPT,
    ReviewCategory.STYLE: STYLE_SYSTEM_PROMPT,
}

MODEL = "claude-sonnet-4-20250514"

# Simulate mode: use mock responses instead of calling Anthropic API
SIMULATE = os.environ.get("REVIEW_SWARM_SIMULATE", "").lower() in ("1", "true", "yes")


def _parse_json_response(text: str) -> dict[str, Any]:
    """Extract JSON from a model response, handling markdown code fences."""
    text = text.strip()
    if text.startswith("```"):
        # Strip code fence
        lines = text.split("\n")
        lines = lines[1:]  # remove opening fence
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines)
    # Try direct parse first, then look for JSON object in the text
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # Try to find JSON object in the text
        start = text.find("{")
        end = text.rfind("}") + 1
        if start >= 0 and end > start:
            return json.loads(text[start:end])
        raise


@weave.op(call_display_name="🔍 Specialist: {category}")
async def run_specialist_agent(
    client: Any,
    category: str,
    diff: str,
) -> dict[str, Any]:
    """Run a single specialist review agent."""
    cat = ReviewCategory(category)
    system_prompt = AGENT_PROMPTS[cat]

    if SIMULATE:
        from .mock_responses import MOCK_FINDINGS, _simulate_latency, _simulate_tokens
        await asyncio.sleep(0.3 + 0.2 * hash(category) % 5 * 0.1)  # stagger slightly
        latency_ms = _simulate_latency()
        findings = MOCK_FINDINGS.get(cat, [])
        return AgentReview(
            agent=cat,
            findings=findings,
            summary=f"{cat.value.title()} specialist identified {len(findings)} issue(s) in the diff.",
            tokens_used=_simulate_tokens(),
            latency_ms=latency_ms,
        ).model_dump()

    start = time.perf_counter()
    response = await client.messages.create(
        model=MODEL,
        max_tokens=4096,
        system=system_prompt,
        messages=[
            {
                "role": "user",
                "content": f"Review this code diff:\n\n```\n{diff}\n```",
            }
        ],
    )
    latency_ms = (time.perf_counter() - start) * 1000

    raw_text = response.content[0].text
    parsed = _parse_json_response(raw_text)

    findings = []
    for f in parsed.get("findings", []):
        findings.append(
            Finding(
                category=cat,
                severity=Severity(f["severity"]),
                title=f["title"],
                description=f["description"],
                line_range=f.get("line_range"),
                suggestion=f.get("suggestion"),
                confidence=f.get("confidence", 0.8),
            )
        )

    return AgentReview(
        agent=cat,
        findings=findings,
        summary=parsed.get("summary", ""),
        tokens_used=response.usage.input_tokens + response.usage.output_tokens,
        latency_ms=latency_ms,
    ).model_dump()


@weave.op(call_display_name="⚔️ Challenge: {challenger} vs {target}")
async def run_challenge(
    challenger: str,
    target: str,
    finding_title: str,
    reason: str,
    verdict: str,
) -> dict[str, Any]:
    """Individual challenge in the adversarial debate (traced separately for visibility)."""
    await asyncio.sleep(0.1)
    return {
        "challenger": challenger,
        "target_agent": target,
        "finding_title": finding_title,
        "reason": reason,
        "verdict": verdict,
        "outcome": "Finding removed" if verdict == "dismissed" else "Finding stands",
    }


@weave.op(call_display_name="🗣️ Adversarial Debate")
async def run_debate_round(
    client: Any,
    agent_reviews: list[dict[str, Any]],
    diff: str,
) -> dict[str, Any]:
    """Run adversarial debate — agents challenge each other's findings."""

    if SIMULATE:
        from .mock_responses import MOCK_CHALLENGES
        await asyncio.sleep(0.3)  # simulate debate time

        # Trace each challenge as a sub-op for visibility
        for c in MOCK_CHALLENGES:
            await run_challenge(
                challenger=c.challenger.value,
                target=c.target_agent.value,
                finding_title=c.finding_title,
                reason=c.reason,
                verdict=c.verdict or "upheld",
            )

        # Determine dismissed titles from mock challenges
        dismissed_titles = {
            c.finding_title for c in MOCK_CHALLENGES if c.verdict == "dismissed"
        }

        # Split findings into upheld/dismissed
        upheld = []
        dismissed = []
        for r in agent_reviews:
            for f in r["findings"]:
                finding = Finding(**f) if isinstance(f, dict) else f
                if finding.title in dismissed_titles:
                    dismissed.append(finding)
                else:
                    upheld.append(finding)

        return DebateRound(
            challenges=MOCK_CHALLENGES,
            findings_upheld=upheld,
            findings_dismissed=dismissed,
        ).model_dump()

    async def _get_challenges_from_agent(
        reviewer_cat: ReviewCategory, other_findings: list[dict],
    ) -> list[Challenge]:
        """Single agent's challenge pass."""
        challenge_prompt = f"""You are the {reviewer_cat.value.upper()} specialist.
Review these findings from other specialists and challenge any that you believe are FALSE POSITIVES.
Only challenge findings you have strong evidence against.

Code diff for context:
```
{diff}
```

Other specialists' findings:
{json.dumps(other_findings, indent=2)}

Respond in JSON:
{{
  "challenges": [
    {{
      "finding_title": "Title of finding you're challenging",
      "target_agent": "security|performance|logic|style",
      "reason": "Why this is a false positive"
    }}
  ]
}}

If no challenges, respond: {{"challenges": []}}"""

        response = await client.messages.create(
            model=MODEL,
            max_tokens=2048,
            messages=[{"role": "user", "content": challenge_prompt}],
        )

        raw = _parse_json_response(response.content[0].text)
        result = []
        for c in raw.get("challenges", []):
            try:
                result.append(
                    Challenge(
                        challenger=reviewer_cat,
                        target_agent=ReviewCategory(c["target_agent"]),
                        finding_title=c["finding_title"],
                        reason=c["reason"],
                    )
                )
            except (ValueError, KeyError):
                continue
        return result

    # Build challenge tasks — each agent reviews others' findings (in parallel)
    challenge_tasks = []
    for review in agent_reviews:
        reviewer_cat = ReviewCategory(review["agent"])
        other_findings = []
        for other in agent_reviews:
            if other["agent"] == review["agent"]:
                continue
            for f in other["findings"]:
                other_findings.append(f)

        if not other_findings:
            continue

        challenge_tasks.append(_get_challenges_from_agent(reviewer_cat, other_findings))

    # Run all challenge passes in parallel
    challenge_results = await asyncio.gather(*challenge_tasks)
    challenges: list[Challenge] = []
    for result in challenge_results:
        challenges.extend(result)

    if not challenges:
        # No debate needed — all findings stand
        all_findings = []
        for r in agent_reviews:
            all_findings.extend([Finding(**f) for f in r["findings"]])
        return DebateRound(
            challenges=[],
            findings_upheld=all_findings,
            findings_dismissed=[],
        ).model_dump()

    # Have the Lead resolve challenges
    debate_context = {
        "challenges": [c.model_dump() for c in challenges],
        "all_findings": [],
    }
    for r in agent_reviews:
        for f in r["findings"]:
            debate_context["all_findings"].append(f)

    response = await client.messages.create(
        model=MODEL,
        max_tokens=2048,
        system=DEBATE_SYSTEM_PROMPT,
        messages=[
            {
                "role": "user",
                "content": f"Here are the challenges and findings to adjudicate:\n\n{json.dumps(debate_context, indent=2)}",
            }
        ],
    )

    verdicts_raw = _parse_json_response(response.content[0].text)
    dismissed_titles = set()
    for v in verdicts_raw.get("verdicts", []):
        if v.get("verdict") == "dismissed":
            dismissed_titles.add(v["finding_title"])

    # Update challenges with verdicts
    for c in challenges:
        for v in verdicts_raw.get("verdicts", []):
            if v["finding_title"] == c.finding_title:
                c.verdict = v["verdict"]

    # Split findings
    upheld = []
    dismissed = []
    for r in agent_reviews:
        for f in r["findings"]:
            finding = Finding(**f)
            if finding.title in dismissed_titles:
                dismissed.append(finding)
            else:
                upheld.append(finding)

    return DebateRound(
        challenges=challenges,
        findings_upheld=upheld,
        findings_dismissed=dismissed,
    ).model_dump()


@weave.op(call_display_name="📊 Lead Consolidation")
async def run_lead_consolidation(
    client: Any,
    agent_reviews: list[dict[str, Any]],
    debate: dict[str, Any],
    diff: str,
) -> dict[str, Any]:
    """Lead agent consolidates all findings into a final review."""

    if SIMULATE:
        from .mock_responses import _simulate_latency, _simulate_tokens
        await asyncio.sleep(0.4)  # simulate consolidation time

        # Collect upheld findings, sorted by severity
        upheld_findings = debate.get("findings_upheld", [])
        findings = []
        for f in upheld_findings:
            finding = Finding(**f) if isinstance(f, dict) else f
            findings.append(finding)

        # Sort by severity (critical first)
        severity_order = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}
        findings.sort(key=lambda f: severity_order.get(f.severity.value, 5))

        total_tokens = sum(r.get("tokens_used", 0) for r in agent_reviews) + _simulate_tokens()
        total_latency = sum(r.get("latency_ms", 0) for r in agent_reviews) + _simulate_latency()

        return FinalReview(
            findings=findings,
            summary=(
                f"Multi-agent review identified {len(findings)} verified issues after adversarial debate. "
                f"Critical security vulnerabilities (SQL injection, command injection) require immediate remediation. "
                f"Performance issues (N+1 queries, unbounded cache) impact scalability. "
                f"Authorization gap (IDOR) presents significant business logic risk."
            ),
            risk_score=8.5,
            agent_reviews=[AgentReview(**r) for r in agent_reviews],
            debate=DebateRound(**debate),
            total_tokens=total_tokens,
            total_latency_ms=total_latency,
        ).model_dump()

    # Use only upheld findings from the debate
    upheld_findings = debate.get("findings_upheld", [])

    context = f"""Here are the upheld findings from the specialist review panel after adversarial debate:

Findings ({len(upheld_findings)} total):
{json.dumps(upheld_findings, indent=2)}

Debate summary:
- Challenges raised: {len(debate.get("challenges", []))}
- Findings dismissed as false positives: {len(debate.get("findings_dismissed", []))}

Original code diff:
```
{diff}
```

Consolidate these into a final prioritized review."""

    start = time.perf_counter()
    response = await client.messages.create(
        model=MODEL,
        max_tokens=4096,
        system=LEAD_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": context}],
    )
    latency_ms = (time.perf_counter() - start) * 1000

    raw = _parse_json_response(response.content[0].text)

    findings = []
    for f in raw.get("findings", []):
        findings.append(
            Finding(
                category=ReviewCategory(f["category"]),
                severity=Severity(f["severity"]),
                title=f["title"],
                description=f["description"],
                line_range=f.get("line_range"),
                suggestion=f.get("suggestion"),
                confidence=f.get("confidence", 0.8),
            )
        )

    total_tokens = sum(r.get("tokens_used", 0) for r in agent_reviews)
    total_tokens += response.usage.input_tokens + response.usage.output_tokens
    total_latency = sum(r.get("latency_ms", 0) for r in agent_reviews) + latency_ms

    return FinalReview(
        findings=findings,
        summary=raw.get("summary", ""),
        risk_score=raw.get("risk_score", 0.0),
        agent_reviews=[AgentReview(**r) for r in agent_reviews],
        debate=DebateRound(**debate),
        total_tokens=total_tokens,
        total_latency_ms=total_latency,
    ).model_dump()


@weave.op(call_display_name="🐝 Code Review Swarm Pipeline")
async def review_diff(diff: str, project: str | None = None) -> dict[str, Any]:
    """
    Run the full multi-agent review pipeline on a code diff.

    Pipeline:
    1. Parallel specialist agents (Security, Performance, Logic, Style)
    2. Adversarial debate round (agents challenge each other)
    3. Lead consolidation (final ranked review)
    """
    if SIMULATE:
        client = None  # No API client needed in simulate mode
    else:
        import anthropic
        client = anthropic.AsyncAnthropic()

    # Phase 1: Run all specialists in parallel
    specialist_tasks = [
        run_specialist_agent(client, cat.value, diff)
        for cat in ReviewCategory
    ]
    agent_reviews = await asyncio.gather(*specialist_tasks)

    # Phase 2: Adversarial debate
    debate = await run_debate_round(client, list(agent_reviews), diff)

    # Phase 3: Lead consolidation
    final = await run_lead_consolidation(client, list(agent_reviews), debate, diff)

    # Log summary metrics for Weave dashboard
    await log_review_metrics(final)

    return final


@weave.op(call_display_name="📈 Review Metrics")
async def log_review_metrics(review: dict[str, Any]) -> dict[str, Any]:
    """Log structured metrics for Weave visualization."""
    findings = review.get("findings", [])
    severity_counts = {}
    category_counts = {}
    for f in findings:
        sev = f["severity"] if isinstance(f, dict) else f.severity.value
        cat = f["category"] if isinstance(f, dict) else f.category.value
        severity_counts[sev] = severity_counts.get(sev, 0) + 1
        category_counts[cat] = category_counts.get(cat, 0) + 1

    debate = review.get("debate", {})
    return {
        "risk_score": review.get("risk_score", 0),
        "total_findings": len(findings),
        "critical_count": severity_counts.get("critical", 0),
        "high_count": severity_counts.get("high", 0),
        "medium_count": severity_counts.get("medium", 0),
        "low_count": severity_counts.get("low", 0),
        "categories": category_counts,
        "challenges_raised": len(debate.get("challenges", [])),
        "findings_dismissed": len(debate.get("findings_dismissed", [])),
        "false_positive_rate": (
            len(debate.get("findings_dismissed", []))
            / max(len(findings) + len(debate.get("findings_dismissed", [])), 1)
        ),
        "total_tokens": review.get("total_tokens", 0),
        "total_latency_ms": review.get("total_latency_ms", 0),
    }
