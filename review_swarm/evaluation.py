"""Evaluation harness — runs the swarm against labeled diffs and scores via Weave."""

from __future__ import annotations

import asyncio
from typing import Any

import weave
from weave import EvaluationLogger

from .agents import review_diff
from .models import ReviewCategory, Severity


# Labeled evaluation dataset: diffs with known issues
EVAL_DATASET = [
    {
        "name": "sql_injection",
        "diff": '''def get_user(username):
    query = f"SELECT * FROM users WHERE name = '{username}'"
    return db.execute(query)
''',
        "expected_categories": ["security"],
        "expected_min_severity": "critical",
        "description": "Classic SQL injection via string formatting",
    },
    {
        "name": "n_plus_one",
        "diff": '''async def get_orders_with_items(db):
    orders = await db.fetch_all("SELECT * FROM orders")
    for order in orders:
        order.items = await db.fetch_all(
            f"SELECT * FROM items WHERE order_id = {order.id}"
        )
    return orders
''',
        "expected_categories": ["performance"],
        "expected_min_severity": "high",
        "description": "N+1 query pattern in async database code",
    },
    {
        "name": "off_by_one",
        "diff": '''def binary_search(arr, target):
    low, high = 0, len(arr)
    while low < high:
        mid = (low + high) // 2
        if arr[mid] == target:
            return mid
        elif arr[mid] < target:
            low = mid
        else:
            high = mid
    return -1
''',
        "expected_categories": ["logic"],
        "expected_min_severity": "high",
        "description": "Binary search with infinite loop (low = mid instead of mid + 1)",
    },
    {
        "name": "hardcoded_secret",
        "diff": '''import requests

API_KEY = "sk-prod-a8f29c3d4e5f6789abcdef0123456789"

def call_api(endpoint, data):
    headers = {"Authorization": f"Bearer {API_KEY}"}
    response = requests.post(
        f"https://api.example.com/{endpoint}",
        json=data,
        headers=headers
    )
    return response.json()
''',
        "expected_categories": ["security"],
        "expected_min_severity": "critical",
        "description": "Hardcoded production API key in source code",
    },
    {
        "name": "resource_leak",
        "diff": '''def process_files(paths):
    results = []
    for path in paths:
        f = open(path, 'r')
        data = f.read()
        results.append(transform(data))
    return results
''',
        "expected_categories": ["logic", "style"],
        "expected_min_severity": "medium",
        "description": "File handles never closed — resource leak",
    },
    {
        "name": "race_condition",
        "diff": '''import threading

balance = 0

def deposit(amount):
    global balance
    current = balance
    # Simulate some processing
    balance = current + amount

def withdraw(amount):
    global balance
    current = balance
    if current >= amount:
        balance = current - amount
        return True
    return False
''',
        "expected_categories": ["security", "logic"],
        "expected_min_severity": "high",
        "description": "Race condition in shared mutable state without locks",
    },
    {
        "name": "unbounded_memory",
        "diff": '''class EventCache:
    def __init__(self):
        self._cache = {}

    def record(self, event_id, data):
        self._cache[event_id] = data

    def get(self, event_id):
        return self._cache.get(event_id)
''',
        "expected_categories": ["performance"],
        "expected_min_severity": "medium",
        "description": "Cache grows without bound — no eviction policy",
    },
    {
        "name": "command_injection",
        "diff": '''import subprocess

def convert_image(filename, format):
    cmd = f"convert {filename} output.{format}"
    result = subprocess.run(cmd, shell=True, capture_output=True)
    return result.stdout
''',
        "expected_categories": ["security"],
        "expected_min_severity": "critical",
        "description": "Command injection via unsanitized filename in shell=True",
    },
]

SEVERITY_ORDER = {
    Severity.CRITICAL: 4,
    Severity.HIGH: 3,
    Severity.MEDIUM: 2,
    Severity.LOW: 1,
    Severity.INFO: 0,
}


def _severity_from_str(s: str) -> int:
    return SEVERITY_ORDER.get(Severity(s), 0)


def score_review(result: dict[str, Any], expected: dict[str, Any]) -> dict[str, float]:
    """Score a review result against expected labels."""
    findings = result.get("findings", [])
    expected_cats = set(expected["expected_categories"])
    min_sev = _severity_from_str(expected["expected_min_severity"])

    # Did the swarm find the right category?
    found_cats = set()
    max_severity_found = 0
    for f in findings:
        cat = f.get("category", "")
        if isinstance(cat, str):
            found_cats.add(cat)
        sev_val = _severity_from_str(f.get("severity", "info"))
        max_severity_found = max(max_severity_found, sev_val)

    # Category recall: did we find the expected category?
    category_hit = 1.0 if expected_cats & found_cats else 0.0

    # Severity accuracy: did we rate it at least as severe as expected?
    severity_hit = 1.0 if max_severity_found >= min_sev else 0.0

    # Precision proxy: what fraction of findings are in expected categories?
    if findings:
        relevant = sum(1 for f in findings if f.get("category") in expected_cats)
        precision = relevant / len(findings)
    else:
        precision = 0.0

    # Did we find anything at all?
    detection = 1.0 if len(findings) > 0 else 0.0

    return {
        "category_recall": category_hit,
        "severity_accuracy": severity_hit,
        "precision": precision,
        "detection_rate": detection,
    }


@weave.op()
async def run_evaluation() -> dict[str, Any]:
    """Run the full evaluation suite and log to Weave."""
    eval_logger = EvaluationLogger(
        model="code-review-swarm-v1",
        dataset="known-bugs-v1",
    )

    results_summary = {
        "category_recall": 0.0,
        "severity_accuracy": 0.0,
        "precision": 0.0,
        "detection_rate": 0.0,
        "total_samples": len(EVAL_DATASET),
    }

    for sample in EVAL_DATASET:
        # Run the swarm
        result = await review_diff(sample["diff"])

        # Score it
        scores = score_review(result, sample)

        # Log to Weave
        eval_logger.log_example(
            inputs={"diff": sample["diff"], "name": sample["name"]},
            output=result,
            scores=scores,
        )

        # Accumulate
        for key in ["category_recall", "severity_accuracy", "precision", "detection_rate"]:
            results_summary[key] += scores[key]

    # Average
    n = len(EVAL_DATASET)
    for key in ["category_recall", "severity_accuracy", "precision", "detection_rate"]:
        results_summary[key] /= n

    eval_logger.log_summary(results_summary)

    return results_summary


def run_eval_sync() -> dict[str, Any]:
    """Synchronous wrapper for the evaluation."""
    return asyncio.run(run_evaluation())
