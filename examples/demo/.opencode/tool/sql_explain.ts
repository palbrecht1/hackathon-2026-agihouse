import { tool } from "@opencode-ai/plugin"

export default tool({
  description: "Run EXPLAIN on a SQL query against the dev database and return the plan.",
  args: { query: tool.schema.string().describe("The SQL query to explain") },
  async execute(args) {
    // Demo stub: a real tool would connect to DEV_DATABASE_URL and run EXPLAIN.
    // Returns a plan string the reviewer subagent inspects for "Seq Scan".
    const proc = Bun.spawn(["psql", process.env.DEV_DATABASE_URL ?? "", "-c", `EXPLAIN ${args.query}`], { stdout: "pipe", stderr: "pipe" })
    const out = await new Response(proc.stdout).text()
    const err = await new Response(proc.stderr).text()
    return out || `EXPLAIN failed: ${err}`
  },
})
