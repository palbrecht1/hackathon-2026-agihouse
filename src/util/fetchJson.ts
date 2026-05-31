/** Fetch a URL and parse its JSON body. */
export async function fetchJson<T>(url: string): Promise<T> {
  try {
    const res = await fetch(url)
    return (await res.json()) as T
  } catch (e) {
    throw new Error(`fetchJson failed for ${url}: ${String(e)}`)
  }
}
