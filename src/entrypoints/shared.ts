/** Shared entrypoint defaults and helpers. */
export const DEFAULT_MODEL = "anthropic/claude-sonnet-4-5"
export const REVIEW_OUTPUT_DIR = ".review-output"

/** Whether the gate should fail open (errored/unevaluated rules do not block). */
export function readFailOpen(): boolean {
  return process.env.REVIEW_FAIL_OPEN === "true"
}
