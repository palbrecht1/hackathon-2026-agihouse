"""Data models for the review swarm."""

from __future__ import annotations

from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class Severity(str, Enum):
    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"
    INFO = "info"


class ReviewCategory(str, Enum):
    SECURITY = "security"
    PERFORMANCE = "performance"
    LOGIC = "logic"
    STYLE = "style"


class Finding(BaseModel):
    """A single issue found by a specialist agent."""

    category: ReviewCategory
    severity: Severity
    title: str
    description: str
    line_range: Optional[str] = None
    suggestion: Optional[str] = None
    confidence: float = Field(ge=0.0, le=1.0, default=0.8)


class Challenge(BaseModel):
    """A challenge from one agent to another's finding."""

    challenger: ReviewCategory
    target_agent: ReviewCategory
    finding_title: str
    reason: str
    verdict: Optional[str] = None  # Set by Lead after debate


class AgentReview(BaseModel):
    """Output from a single specialist agent."""

    agent: ReviewCategory
    findings: list[Finding] = Field(default_factory=list)
    summary: str = ""
    tokens_used: int = 0
    latency_ms: float = 0.0


class DebateRound(BaseModel):
    """Result of the adversarial debate between agents."""

    challenges: list[Challenge] = Field(default_factory=list)
    findings_upheld: list[Finding] = Field(default_factory=list)
    findings_dismissed: list[Finding] = Field(default_factory=list)


class FinalReview(BaseModel):
    """The consolidated final review from the Lead agent."""

    findings: list[Finding] = Field(default_factory=list)
    summary: str = ""
    risk_score: float = Field(ge=0.0, le=10.0, default=0.0)
    agent_reviews: list[AgentReview] = Field(default_factory=list)
    debate: Optional[DebateRound] = None
    total_tokens: int = 0
    total_latency_ms: float = 0.0
