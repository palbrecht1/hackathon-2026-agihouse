"""CLI interface for the Code Review Swarm."""

from __future__ import annotations

import asyncio
import os
import sys

import click

from .demos import DEMO_DIFFS, KILLER_DEMO, KILLER_DEMO_NAME
from .ui import console, run_review_with_ui


EXAMPLE_DIFF = '''def authenticate(request):
    username = request.POST.get("username")
    password = request.POST.get("password")

    # SQL query to check credentials
    query = f"SELECT * FROM users WHERE username = '{username}' AND password = '{password}'"
    user = db.execute(query).fetchone()

    if user:
        token = generate_token(user.id)
        log.info(f"User logged in: {username}, password: {password}")
        return {"token": token, "user": user}

    return {"error": "Invalid credentials"}, 401


def get_user_profile(user_id):
    """Fetch user profile with all related data."""
    user = db.execute(f"SELECT * FROM users WHERE id = {user_id}").fetchone()
    orders = db.execute(f"SELECT * FROM orders WHERE user_id = {user_id}").fetchall()

    # Load all items for all orders
    for order in orders:
        items = db.execute(f"SELECT * FROM items WHERE order_id = {order.id}").fetchall()
        order.items = items

    # Cache without eviction
    if not hasattr(get_user_profile, '_cache'):
        get_user_profile._cache = {}
    get_user_profile._cache[user_id] = user

    return user


class PaymentProcessor:
    def __init__(self):
        self.api_key = "sk-live-abc123def456ghi789jkl012mno345pqr678"

    def charge(self, amount, card_number):
        import subprocess
        # Log for debugging
        print(f"Charging {card_number} for ${amount}")
        result = subprocess.run(
            f"curl -X POST https://api.payments.com/charge -d 'amount={amount}&card={card_number}'",
            shell=True, capture_output=True
        )
        return result.stdout
'''


@click.group()
def cli():
    """🐝 Code Review Swarm — Multi-agent code review with adversarial debate."""
    pass


@cli.command()
@click.option("--file", "-f", type=click.Path(exists=True), help="Path to a diff/patch file to review")
@click.option("--stdin", "-s", is_flag=True, help="Read diff from stdin (e.g., git diff | review-swarm review -s)")
@click.option("--github", "-g", type=str, default=None, help="GitHub PR URL or owner/repo#number")
@click.option("--project", "-p", type=str, default=None, help="W&B Weave project (team/project)")
@click.option("--demo", "-d", is_flag=True, help="Run with a built-in example diff (for demo purposes)")
def review(file: str | None, stdin: bool, github: str | None, project: str | None, demo: bool):
    """Review a code diff with the multi-agent swarm."""
    # Resolve Weave project
    weave_project = project or os.environ.get("WEAVE_PROJECT")

    # Get the diff content
    if demo:
        diff = EXAMPLE_DIFF
        console.print("[dim]Using built-in demo diff...[/dim]")
    elif github:
        from .github import fetch_github_diff

        console.print(f"[dim]Fetching PR diff from GitHub: {github}[/dim]")
        try:
            diff, desc = asyncio.run(fetch_github_diff(github))
            console.print(f"[dim]Got diff for: {desc} ({len(diff)} bytes)[/dim]")
        except Exception as e:
            console.print(f"[red]Error fetching PR: {e}[/red]")
            sys.exit(1)
    elif stdin:
        diff = sys.stdin.read()
        if not diff.strip():
            console.print("[red]Error: No input received from stdin[/red]")
            sys.exit(1)
    elif file:
        with open(file) as f:
            diff = f.read()
    else:
        console.print("[red]Error: Provide --file, --stdin, --github, or --demo[/red]")
        console.print("  review-swarm review --demo")
        console.print("  review-swarm review -f my_diff.patch")
        console.print("  review-swarm review -g daytonaio/daytona#4822")
        console.print("  review-swarm review -g https://github.com/owner/repo/pull/123")
        console.print("  git diff | review-swarm review -s")
        sys.exit(1)

    asyncio.run(run_review_with_ui(diff, weave_project=weave_project))


@cli.command()
@click.option("--project", "-p", type=str, default=None, help="W&B Weave project (team/project)")
def evaluate(project: str | None):
    """Run the evaluation suite against known-buggy diffs."""
    import weave as weave_mod

    from .evaluation import run_eval_sync

    weave_project = project or os.environ.get("WEAVE_PROJECT")
    if weave_project:
        weave_mod.init(weave_project)

    console.print(
        "[bold]Running evaluation against labeled dataset...[/bold]\n"
        "This tests the swarm against 8 known-buggy code samples.\n"
    )

    results = run_eval_sync()

    console.print("\n[bold green]✓ Evaluation complete![/bold green]\n")
    console.print(f"  Category Recall:    {results['category_recall']:.1%}")
    console.print(f"  Severity Accuracy:  {results['severity_accuracy']:.1%}")
    console.print(f"  Precision:          {results['precision']:.1%}")
    console.print(f"  Detection Rate:     {results['detection_rate']:.1%}")

    if weave_project:
        console.print(f"\n[dim]🔗 View evaluation in Weave: https://wandb.ai/{weave_project}/weave[/dim]")


@cli.command()
@click.option(
    "--scenario", "-s",
    type=click.Choice(list(DEMO_DIFFS.keys()) + ["basic"]),
    default=None,
    help="Which demo scenario to run",
)
@click.option("--list-scenarios", "-l", is_flag=True, help="List available demo scenarios")
def demo(scenario: str | None, list_scenarios: bool):
    """Run a demo with real-world OSS code diffs.

    Without --scenario, runs the 'killer' demo (most impressive for presentations).
    Use --list-scenarios to see all available demos.
    """
    weave_project = os.environ.get("WEAVE_PROJECT")

    if list_scenarios:
        console.print("\n[bold]Available demo scenarios:[/bold]\n")
        console.print("  [cyan]basic[/cyan]         — Synthetic buggy code (SQL injection, hardcoded keys, etc.)")
        for name, info in DEMO_DIFFS.items():
            console.print(f"  [cyan]{name}[/cyan]  — {info['description']}")
        console.print(f"\n  Default (no --scenario): [bold]{KILLER_DEMO_NAME}[/bold]")
        console.print("\n  Usage: review-swarm demo -s daytona-workspace")
        return

    if scenario == "basic":
        diff = EXAMPLE_DIFF
        console.print("[dim]Running basic synthetic demo...[/dim]")
    elif scenario and scenario in DEMO_DIFFS:
        info = DEMO_DIFFS[scenario]
        diff = info["diff"]
        console.print(f"[dim]Demo: {info['description']}[/dim]")
        console.print(f"[dim]Source: {info['source']}[/dim]")
    else:
        # Default: killer demo
        info = DEMO_DIFFS[KILLER_DEMO_NAME]
        diff = KILLER_DEMO
        console.print(f"[bold]🎯 Running killer demo for presentation[/bold]")
        console.print(f"[dim]Scenario: {info['description']}[/dim]")
        console.print(f"[dim]Source: {info['source']}[/dim]")

    asyncio.run(run_review_with_ui(diff, weave_project=weave_project))


@cli.command()
@click.argument("pr_url")
@click.option("--project", "-p", type=str, default=None, help="W&B Weave project (team/project)")
def github(pr_url: str, project: str | None):
    """Review a GitHub PR directly. Accepts URL or owner/repo#number.

    Examples:
        review-swarm github https://github.com/daytonaio/daytona/pull/4822
        review-swarm github daytonaio/daytona#4858
    """
    from .github import fetch_github_diff

    weave_project = project or os.environ.get("WEAVE_PROJECT")

    console.print(f"[dim]Fetching PR diff: {pr_url}[/dim]")
    try:
        diff, desc = asyncio.run(fetch_github_diff(pr_url))
        console.print(f"[green]✓[/green] Got diff for [bold]{desc}[/bold] ({len(diff):,} bytes)")
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        sys.exit(1)

    # Truncate very large diffs to avoid token limits
    if len(diff) > 15000:
        console.print(f"[yellow]⚠ Diff is large ({len(diff):,} chars). Truncating to 15,000 for review.[/yellow]")
        diff = diff[:15000] + "\n\n... (truncated)"

    asyncio.run(run_review_with_ui(diff, weave_project=weave_project))


@cli.command("publish-prompts")
@click.option("--project", "-p", type=str, default=None, help="W&B Weave project (team/project)")
def publish_prompts_cmd(project: str | None):
    """Publish all agent prompts to Weave for version tracking.

    Once published, prompts are editable in the W&B Weave UI.
    Changes take effect on the next review run without code changes.
    """
    from .weave_prompts import publish_prompts

    weave_project = project or os.environ.get("WEAVE_PROJECT")
    if not weave_project:
        console.print("[red]Error: Set WEAVE_PROJECT env var or use --project[/red]")
        sys.exit(1)

    console.print(f"[bold]Publishing prompts to Weave project: {weave_project}[/bold]\n")
    refs = publish_prompts(weave_project)

    for name, uri in refs.items():
        console.print(f"  [green]✓[/green] {name} → [dim]{uri}[/dim]")

    console.print(f"\n[bold green]✓ Published {len(refs)} prompts![/bold green]")
    console.print(f"[dim]Edit them in the Weave UI: https://wandb.ai/{weave_project}/weave/prompts[/dim]")


def main():
    cli()


if __name__ == "__main__":
    main()
