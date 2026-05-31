import type { Source, SourceResult } from "./types"

export type DiffRunner = (base: string) => Promise<string>

const defaultRunner: DiffRunner = async (base) => {
  const proc = Bun.spawn(["git", "diff", "--unified=3", `${base}...HEAD`], { stdout: "pipe" })
  return await new Response(proc.stdout).text()
}

/** Splits `git diff` output into a per-file map keyed by the new path. */
export class LocalGitSource implements Source {
  constructor(private base: string, private runner: DiffRunner = defaultRunner) {}

  async read(): Promise<SourceResult> {
    const raw = await this.runner(this.base)
    const diffByFile: Record<string, string> = {}
    let currentFile: string | null = null
    let buffer: string[] = []

    const flush = () => {
      if (currentFile && buffer.length) diffByFile[currentFile] = buffer.join("\n")
      buffer = []
    }

    for (const line of raw.split("\n")) {
      const header = line.match(/^diff --git a\/.+ b\/(.+)$/)
      if (header) {
        flush()
        currentFile = header[1]!
      }
      if (currentFile) buffer.push(line)
    }
    flush()
    return { diffByFile }
  }
}
