"""Mock agent responses for demo mode without API keys.

Generates realistic-looking responses that still trace properly in Weave.
"""

from __future__ import annotations

import asyncio
import random
import time

from .models import (
    AgentReview,
    Challenge,
    DebateRound,
    FinalReview,
    Finding,
    ReviewCategory,
    Severity,
)

# Realistic findings per specialist, keyed by category
MOCK_FINDINGS = {
    ReviewCategory.SECURITY: [
        Finding(
            category=ReviewCategory.SECURITY,
            severity=Severity.CRITICAL,
            title="SQL Injection via string interpolation",
            description="User-controlled input is directly interpolated into SQL queries without parameterization, enabling full database compromise.",
            line_range="L15-L22",
            suggestion="Use parameterized queries: db.execute('SELECT * FROM users WHERE id = ?', (user_id,))",
            confidence=0.97,
        ),
        Finding(
            category=ReviewCategory.SECURITY,
            severity=Severity.CRITICAL,
            title="Command injection in exec endpoint",
            description="User-supplied command string is passed directly to shell execution without sanitization or allowlisting.",
            line_range="L58-L65",
            suggestion="Implement a command allowlist and use subprocess with shell=False, splitting args explicitly.",
            confidence=0.95,
        ),
        Finding(
            category=ReviewCategory.SECURITY,
            severity=Severity.HIGH,
            title="Path traversal in file operations",
            description="File path from user input is not validated against directory traversal patterns (../ sequences).",
            line_range="L30-L35",
            suggestion="Normalize the path and verify it stays within the sandbox root using os.path.realpath().",
            confidence=0.92,
        ),
        Finding(
            category=ReviewCategory.SECURITY,
            severity=Severity.MEDIUM,
            title="Sensitive data in log output",
            description="Password and authentication tokens are logged in plaintext, risking credential exposure via log aggregation.",
            line_range="L9",
            suggestion="Redact sensitive fields before logging. Use structured logging with field filtering.",
            confidence=0.88,
        ),
    ],
    ReviewCategory.PERFORMANCE: [
        Finding(
            category=ReviewCategory.PERFORMANCE,
            severity=Severity.HIGH,
            title="N+1 query pattern in loop",
            description="Database queries inside a for-loop cause O(N) round trips. For 100 orders, this generates 100+ queries.",
            line_range="L38-L42",
            suggestion="Use a JOIN or batch query: SELECT items.* FROM items WHERE order_id IN (...)",
            confidence=0.94,
        ),
        Finding(
            category=ReviewCategory.PERFORMANCE,
            severity=Severity.MEDIUM,
            title="Unbounded in-memory cache",
            description="Cache dictionary grows without limit, causing memory leaks in long-running processes.",
            line_range="L45-L48",
            suggestion="Use functools.lru_cache(maxsize=1000) or a TTL-based cache like cachetools.TTLCache.",
            confidence=0.90,
        ),
        Finding(
            category=ReviewCategory.PERFORMANCE,
            severity=Severity.LOW,
            title="Redundant database round-trip",
            description="User object is fetched separately despite being available from the authentication context.",
            line_range="L34",
            suggestion="Pass the authenticated user object directly instead of re-querying by ID.",
            confidence=0.75,
        ),
    ],
    ReviewCategory.LOGIC: [
        Finding(
            category=ReviewCategory.LOGIC,
            severity=Severity.HIGH,
            title="Missing authorization check (IDOR)",
            description="No verification that the requesting user owns or has access to the target resource. Any authenticated user can access any sandbox.",
            line_range="L52-L56",
            suggestion="Add ownership check: if sandbox.owner_id != auth_context.user_id: raise ForbiddenError()",
            confidence=0.93,
        ),
        Finding(
            category=ReviewCategory.LOGIC,
            severity=Severity.MEDIUM,
            title="Race condition in concurrent access",
            description="Shared mutable state is accessed without synchronization, risking data corruption under concurrent requests.",
            line_range="L70-L78",
            suggestion="Use asyncio.Lock() or database-level locking for atomic read-modify-write operations.",
            confidence=0.82,
        ),
        Finding(
            category=ReviewCategory.LOGIC,
            severity=Severity.LOW,
            title="Swallowed error in exception handler",
            description="Exception is caught and silently ignored, masking potential failures that should propagate.",
            line_range="L85-L88",
            suggestion="At minimum, log the exception. Consider re-raising or returning an error status.",
            confidence=0.78,
        ),
    ],
    ReviewCategory.STYLE: [
        Finding(
            category=ReviewCategory.STYLE,
            severity=Severity.LOW,
            title="Inconsistent error handling pattern",
            description="Mix of exception-based and return-code error handling makes control flow hard to follow.",
            line_range="L20-L30",
            suggestion="Standardize on exception-based error handling throughout the module.",
            confidence=0.72,
        ),
        Finding(
            category=ReviewCategory.STYLE,
            severity=Severity.INFO,
            title="Missing type annotations on public API",
            description="Public functions lack return type annotations, reducing IDE support and documentation quality.",
            line_range="L1-L50",
            suggestion="Add -> TypedDict or -> dict[str, Any] return annotations to all public functions.",
            confidence=0.68,
        ),
    ],
}

MOCK_CHALLENGES = [
    Challenge(
        challenger=ReviewCategory.LOGIC,
        target_agent=ReviewCategory.STYLE,
        finding_title="Missing type annotations on public API",
        reason="This is purely cosmetic and not a real issue in a prototype codebase. The function signatures are clear from context.",
        verdict="dismissed",
    ),
    Challenge(
        challenger=ReviewCategory.PERFORMANCE,
        target_agent=ReviewCategory.SECURITY,
        finding_title="Sensitive data in log output",
        reason="The log statement is inside a debug-only block that won't execute in production configuration.",
        verdict="upheld",
    ),
    Challenge(
        challenger=ReviewCategory.SECURITY,
        target_agent=ReviewCategory.PERFORMANCE,
        finding_title="Redundant database round-trip",
        reason="The auth context user may be stale; re-fetching ensures fresh data for permission checks. This is intentional defensive coding.",
        verdict="dismissed",
    ),
]


def _simulate_latency() -> float:
    """Simulate realistic API latency (800ms-2500ms)."""
    return random.uniform(800, 2500)


def _simulate_tokens() -> int:
    """Simulate realistic token usage."""
    return random.randint(1200, 3500)
