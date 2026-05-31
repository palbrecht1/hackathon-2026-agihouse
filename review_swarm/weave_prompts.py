"""Publish and load prompts from W&B Weave for versioned prompt management.

This enables editing prompts directly in the Weave UI without code changes.
"""

from __future__ import annotations

import weave

from .prompts import (
    DEBATE_SYSTEM_PROMPT,
    LEAD_SYSTEM_PROMPT,
    LOGIC_SYSTEM_PROMPT,
    PERFORMANCE_SYSTEM_PROMPT,
    SECURITY_SYSTEM_PROMPT,
    STYLE_SYSTEM_PROMPT,
)

PROMPT_REGISTRY = {
    "security_specialist": SECURITY_SYSTEM_PROMPT,
    "performance_specialist": PERFORMANCE_SYSTEM_PROMPT,
    "logic_specialist": LOGIC_SYSTEM_PROMPT,
    "style_specialist": STYLE_SYSTEM_PROMPT,
    "lead_consolidator": LEAD_SYSTEM_PROMPT,
    "debate_moderator": DEBATE_SYSTEM_PROMPT,
}


def publish_prompts(project: str) -> dict[str, str]:
    """Publish all agent prompts to Weave for version tracking and UI editing.

    Returns a dict of prompt name -> Weave ref URI.
    """
    weave.init(project)
    refs = {}
    for name, content in PROMPT_REGISTRY.items():
        prompt = weave.StringPrompt(content)
        ref = weave.publish(prompt, name=name)
        refs[name] = ref.uri()
    return refs


def load_prompt(name: str) -> str:
    """Load a prompt from Weave (uses latest published version).

    Falls back to local prompts if Weave ref is not available.
    """
    try:
        ref = weave.ref(name)
        prompt_obj = ref.get()
        return prompt_obj.format()
    except Exception:
        # Fallback to local prompts
        return PROMPT_REGISTRY.get(name, "")


def get_specialist_prompt(category: str) -> str:
    """Get the prompt for a specialist agent, trying Weave first."""
    name = f"{category}_specialist"
    return load_prompt(name)


def get_lead_prompt() -> str:
    """Get the lead consolidator prompt, trying Weave first."""
    return load_prompt("lead_consolidator")


def get_debate_prompt() -> str:
    """Get the debate moderator prompt, trying Weave first."""
    return load_prompt("debate_moderator")
