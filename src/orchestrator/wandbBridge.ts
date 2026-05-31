import protobuf from "protobufjs"
import { gunzipSync } from "node:zlib"

/**
 * W&B Weave's OTLP endpoint only accepts `application/x-protobuf`, but the
 * OpenCode OTEL plugin (@devtheops/opencode-plugin-otel) emits OTLP/JSON. This
 * bridge runs a tiny local HTTP server that the plugin points at: it receives
 * the plugin's OTLP/JSON spans, re-encodes them to OTLP protobuf, and forwards
 * to W&B with Basic auth + project_id. Logs/metrics signals are accepted and
 * dropped (W&B Weave is trace-focused).
 *
 * The proto field NAMES below are camelCase to match the plugin's JSON keys —
 * protobuf wire format only depends on field NUMBERS, so this avoids any
 * snake_case↔camelCase conversion.
 */
const TRACE_PROTO = `
syntax = "proto3";
package otlp;
message AnyValue { string stringValue=1; bool boolValue=2; int64 intValue=3; double doubleValue=4; ArrayValue arrayValue=5; KeyValueList kvlistValue=6; bytes bytesValue=7; }
message ArrayValue { repeated AnyValue values=1; }
message KeyValueList { repeated KeyValue values=1; }
message KeyValue { string key=1; AnyValue value=2; }
message Resource { repeated KeyValue attributes=1; uint32 droppedAttributesCount=2; }
message InstrumentationScope { string name=1; string version=2; repeated KeyValue attributes=3; uint32 droppedAttributesCount=4; }
message Status { string message=2; int32 code=3; }
message Event { fixed64 timeUnixNano=1; string name=2; repeated KeyValue attributes=3; uint32 droppedAttributesCount=4; }
message Link { bytes traceId=1; bytes spanId=2; string traceState=3; repeated KeyValue attributes=4; uint32 droppedAttributesCount=5; }
message Span { bytes traceId=1; bytes spanId=2; string traceState=3; bytes parentSpanId=4; string name=5; int32 kind=6; fixed64 startTimeUnixNano=7; fixed64 endTimeUnixNano=8; repeated KeyValue attributes=9; uint32 droppedAttributesCount=10; repeated Event events=11; uint32 droppedEventsCount=12; repeated Link links=13; uint32 droppedLinksCount=14; Status status=15; }
message ScopeSpans { InstrumentationScope scope=1; repeated Span spans=2; string schemaUrl=3; }
message ResourceSpans { Resource resource=1; repeated ScopeSpans scopeSpans=2; string schemaUrl=3; }
message ExportTraceServiceRequest { repeated ResourceSpans resourceSpans=1; }
`

const ExportTraceServiceRequest = protobuf.parse(TRACE_PROTO).root.lookupType(
  "otlp.ExportTraceServiceRequest",
)

const ID_KEYS = new Set(["traceId", "spanId", "parentSpanId"])

/** Convert OTLP/JSON hex IDs to bytes in place (proto IDs are `bytes`). */
function hexIdsToBytes(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(hexIdsToBytes)
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>
    for (const [k, v] of Object.entries(obj)) {
      if (ID_KEYS.has(k) && typeof v === "string" && /^[0-9a-f]*$/i.test(v)) {
        obj[k] = Buffer.from(v, "hex")
      } else {
        hexIdsToBytes(v)
      }
    }
  }
  return node
}

function jsonTracesToProtobuf(jsonBody: string): Uint8Array {
  const parsed = hexIdsToBytes(JSON.parse(jsonBody))
  return ExportTraceServiceRequest.encode(ExportTraceServiceRequest.fromObject(parsed as object)).finish()
}

export interface WandbBridge {
  /** http://localhost:<port> — point OPENCODE_OTLP_ENDPOINT here. */
  endpoint: string
  close: () => void
}

export interface WandbBridgeOptions {
  apiKey: string
  projectId?: string
  baseUrl?: string
}

/**
 * Start the local OTLP/JSON → W&B protobuf bridge. Returns its base endpoint
 * (the plugin appends /v1/traces etc.) and a close().
 */
export function startWandbBridge(opts: WandbBridgeOptions): WandbBridge {
  const base = (opts.baseUrl ?? "https://trace.wandb.ai/otel").replace(/\/$/, "")
  const auth = "Basic " + Buffer.from(`api:${opts.apiKey}`).toString("base64")

  const server = Bun.serve({
    port: 0, // ephemeral
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (path !== "/v1/traces") return new Response("{}", { status: 200 }) // logs/metrics: accept + drop

      const raw = new Uint8Array(await req.arrayBuffer())
      const bytes = req.headers.get("content-encoding") === "gzip" ? gunzipSync(raw) : raw
      const protobufBody = jsonTracesToProtobuf(Buffer.from(bytes).toString("utf8"))

      const resp = await fetch(`${base}/v1/traces`, {
        method: "POST",
        headers: {
          Authorization: auth,
          "Content-Type": "application/x-protobuf",
          ...(opts.projectId ? { project_id: opts.projectId } : {}),
        },
        // Uint8Array is a valid fetch body at runtime; the DOM BodyInit type omits it.
        body: protobufBody as unknown as BodyInit,
      })
      if (!resp.ok) {
        console.error(`[review] W&B trace export failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`)
      }
      // Always 200 back to the plugin so it does not retry-spam on our errors.
      return new Response("{}", { status: 200 })
    },
  })

  return {
    endpoint: `http://localhost:${server.port}`,
    close: () => server.stop(true),
  }
}
