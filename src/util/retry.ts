/** Retry a flaky async operation a few times before giving up. */
export async function retry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (e) {
      lastError = e
    }
  }
  throw new Error(`retry failed after ${attempts} attempts: ${String(lastError)}`)
}
