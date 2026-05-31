export interface SourceResult {
  /** changed file path -> its unified-diff hunks for this PR/diff */
  diffByFile: Record<string, string>
}

export interface Source {
  read(): Promise<SourceResult>
}

export function changedFiles(result: SourceResult): string[] {
  return Object.keys(result.diffByFile)
}
