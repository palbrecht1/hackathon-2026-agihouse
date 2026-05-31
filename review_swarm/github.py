"""GitHub PR diff fetcher — pull diffs from any public GitHub repo."""

from __future__ import annotations

import re
from urllib.parse import urlparse

import httpx


def parse_github_pr_url(url: str) -> tuple[str, str, int] | None:
    """Parse a GitHub PR URL into (owner, repo, pr_number)."""
    # Handles: https://github.com/owner/repo/pull/123
    match = re.match(r"https?://github\.com/([^/]+)/([^/]+)/pull/(\d+)", url)
    if match:
        return match.group(1), match.group(2), int(match.group(3))
    return None


def parse_github_shorthand(shorthand: str) -> tuple[str, str, int] | None:
    """Parse owner/repo#123 format."""
    match = re.match(r"([^/]+)/([^#]+)#(\d+)", shorthand)
    if match:
        return match.group(1), match.group(2), int(match.group(3))
    return None


async def fetch_pr_diff(owner: str, repo: str, pr_number: int) -> str:
    """Fetch the diff for a GitHub PR."""
    url = f"https://patch-diff.githubusercontent.com/raw/{owner}/{repo}/pull/{pr_number}.diff"
    async with httpx.AsyncClient(follow_redirects=True, timeout=30.0) as client:
        response = await client.get(url)
        response.raise_for_status()
        return response.text


async def fetch_github_diff(identifier: str) -> tuple[str, str]:
    """
    Fetch a diff from GitHub. Accepts:
    - Full URL: https://github.com/owner/repo/pull/123
    - Shorthand: owner/repo#123

    Returns (diff_text, description).
    """
    parsed = parse_github_pr_url(identifier) or parse_github_shorthand(identifier)
    if not parsed:
        raise ValueError(
            f"Invalid GitHub PR identifier: {identifier}\n"
            "Expected: https://github.com/owner/repo/pull/123 or owner/repo#123"
        )

    owner, repo, pr_number = parsed
    diff = await fetch_pr_diff(owner, repo, pr_number)

    if not diff.strip():
        raise ValueError(f"Empty diff returned for {owner}/{repo}#{pr_number}")

    description = f"{owner}/{repo} PR #{pr_number}"
    return diff, description
