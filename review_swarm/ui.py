"""Rich terminal UI for the code review swarm demo."""

from __future__ import annotations

import asyncio
import sys
import time
from typing import Any

import weave
from rich.console import Console
from rich.panel import Panel
from rich.progress import Progress, SpinnerColumn, TextColumn
from rich.table import Table
from rich.tree import Tree

from .agents import review_diff
from .models import FinalReview, ReviewCategory, Severity

console = Console()

SEVERITY_COLORS = {
    "critical": "red bold",
    "high": "red",
    "medium": "yellow",
    "low": "blue",
    "info": "dim",
}

CATEGORY_ICONS = {
    "security": "🔒",
    "performance": "⚡",
    "logic": "🧠",
    "style": "🎨",
}


def render_final_review(result: dict[str, Any]) -> None:
    """Render the final review in a beautiful terminal output."""
    review = FinalReview(**result)

    # Header
    console.print()
    risk_color = "green" if review.risk_score < 3 else "yellow" if review.risk_score < 6 else "red"
    console.print(
        Panel(
            f"[bold]Risk Score: [{risk_color}]{review.risk_score:.1f}/10[/{risk_color}][/bold]\n\n{review.summary}",
            title="[bold]🐝 Code Review Swarm — Final Report[/bold]",
            border_style="bright_blue",
        )
    )

    # Agent orchestration tree
    tree = Tree("[bold]🌐 Agent Orchestration[/bold]")
    parallel = tree.add("[bold cyan]Phase 1: Parallel Specialist Review[/bold cyan]")
    for ar in review.agent_reviews:
        icon = CATEGORY_ICONS.get(ar.agent.value, "•")
        findings_count = len(ar.findings)
        latency = f"{ar.latency_ms:.0f}ms"
        parallel.add(
            f"{icon} [bold]{ar.agent.value.title()}[/bold] — "
            f"{findings_count} finding{'s' if findings_count != 1 else ''} "
            f"[dim]({latency}, {ar.tokens_used} tokens)[/dim]"
        )

    if review.debate:
        debate_node = tree.add("[bold magenta]Phase 2: Adversarial Debate[/bold magenta]")
        n_challenges = len(review.debate.challenges)
        n_dismissed = len(review.debate.findings_dismissed)
        debate_node.add(f"Challenges raised: {n_challenges}")
        debate_node.add(f"Findings dismissed: {n_dismissed}")
        for c in review.debate.challenges:
            verdict_str = f"[green]UPHELD[/green]" if c.verdict == "upheld" else f"[red]DISMISSED[/red]"
            debate_node.add(
                f"  {CATEGORY_ICONS.get(c.challenger.value, '•')} {c.challenger.value} challenges "
                f"{c.target_agent.value}'s \"{c.finding_title}\" → {verdict_str}"
            )

    lead = tree.add("[bold green]Phase 3: Lead Consolidation[/bold green]")
    lead.add(f"Final findings: {len(review.findings)}")

    console.print(tree)
    console.print()

    # Findings table
    if review.findings:
        table = Table(title="📋 Findings (ranked by severity)", show_lines=True)
        table.add_column("#", style="dim", width=3)
        table.add_column("Sev", width=8)
        table.add_column("Cat", width=6)
        table.add_column("Title", min_width=30)
        table.add_column("Confidence", width=10)
        table.add_column("Lines", width=10)

        for i, f in enumerate(review.findings, 1):
            sev_style = SEVERITY_COLORS.get(f.severity.value, "")
            table.add_row(
                str(i),
                f"[{sev_style}]{f.severity.value.upper()}[/{sev_style}]",
                CATEGORY_ICONS.get(f.category.value, ""),
                f.title,
                f"{f.confidence:.0%}",
                f.line_range or "—",
            )

        console.print(table)
        console.print()

        # Detailed findings
        for i, f in enumerate(review.findings, 1):
            sev_style = SEVERITY_COLORS.get(f.severity.value, "")
            console.print(
                Panel(
                    f"[bold]{f.description}[/bold]\n\n"
                    f"[green]💡 Suggestion:[/green] {f.suggestion or 'N/A'}",
                    title=f"[{sev_style}]#{i} {f.title}[/{sev_style}]",
                    subtitle=f"{CATEGORY_ICONS.get(f.category.value, '')} {f.category.value} | {f.severity.value} | {f.confidence:.0%} confidence",
                    border_style=sev_style.split()[0] if sev_style else "white",
                )
            )

    # Stats
    console.print()
    stats = Table.grid(padding=(0, 2))
    stats.add_row(
        f"[dim]Total tokens:[/dim] {review.total_tokens:,}",
        f"[dim]Total latency:[/dim] {review.total_latency_ms:.0f}ms",
        f"[dim]Agents used:[/dim] {len(review.agent_reviews) + 2} (4 specialists + debate + lead)",
    )
    console.print(Panel(stats, title="[dim]📊 Stats[/dim]", border_style="dim"))


async def run_review_with_ui(diff: str, weave_project: str | None = None) -> dict[str, Any]:
    """Run the review pipeline with live progress UI."""
    # Initialize Weave
    if weave_project:
        weave.init(weave_project)
        # Publish prompts to Weave for version tracking & UI editing
        from .weave_prompts import publish_prompts
        try:
            publish_prompts(weave_project)
        except Exception:
            pass  # Non-fatal if publish fails

    console.print(
        Panel(
            "[bold]Starting multi-agent code review...[/bold]\n\n"
            "Pipeline: 4 Specialists (parallel) → Debate → Lead Consolidation",
            title="🐝 Code Review Swarm",
            border_style="bright_blue",
        )
    )
    console.print()

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        console=console,
    ) as progress:
        task = progress.add_task("Running specialist agents in parallel...", total=None)
        start = time.perf_counter()

        result = await review_diff(diff)

        elapsed = time.perf_counter() - start
        progress.update(task, description=f"[green]✓ Complete in {elapsed:.1f}s[/green]")

    render_final_review(result)

    if weave_project:
        console.print(
            f"\n[dim]🔗 View full trace in Weave: https://wandb.ai/{weave_project}/weave[/dim]"
        )

    return result
