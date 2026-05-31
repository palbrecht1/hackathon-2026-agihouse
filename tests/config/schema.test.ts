import { test, expect } from "bun:test"
import { LayerFileSchema } from "../../src/config/schema"

test("valid layer file parses", () => {
  const parsed = LayerFileSchema.parse({
    layer: "MVC",
    description: "controllers handle HTTP only",
    rules: [
      { id: "controller-pure-http", glob: "src/controllers/**/*.ts", severity: "error", rule: "no logic" },
    ],
  })
  expect(parsed.rules[0]!.severity).toBe("error")
})

test("rejects unknown severity", () => {
  expect(() =>
    LayerFileSchema.parse({
      layer: "X",
      description: "d",
      rules: [{ id: "r", glob: "*", severity: "fatal", rule: "x" }],
    }),
  ).toThrow()
})

test("rejects rule missing id", () => {
  expect(() =>
    LayerFileSchema.parse({
      layer: "X",
      description: "d",
      rules: [{ glob: "*", severity: "warn", rule: "x" }],
    }),
  ).toThrow()
})

test("accepts optional tools at layer and rule level", () => {
  const parsed = LayerFileSchema.parse({
    layer: "SQL",
    description: "d",
    tools: ["sql_explain"],
    rules: [{ id: "q", glob: "*.sql.ts", severity: "error", rule: "explain", tools: ["sql_explain"] }],
  })
  expect(parsed.tools).toEqual(["sql_explain"])
  expect(parsed.rules[0]!.tools).toEqual(["sql_explain"])
})
