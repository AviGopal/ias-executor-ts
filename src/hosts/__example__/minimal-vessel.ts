/**
 * minimal-vessel.ts — runnable ≤100 LOC example of a substrate vessel
 * using VesselDaemon to serve a single echo resolver.
 *
 * Spec: openspec/changes/2026-05-23-substrate-explicit-vessels Phase 0, task 0.7.
 *
 * Run:
 *   bun run src/hosts/__example__/minimal-vessel.ts
 *
 * Smoke test:
 *   curl -s -X POST http://localhost:8299/health | jq .
 *   curl -s -X POST http://localhost:8299/resolve \
 *     -H "Content-Type: application/json" \
 *     -d '{"impulse":{"pointer":{"type":"echo"}},"message":"hello"}' | jq .
 */

import { ActivityExecutor } from "../../engine";
import { ExecutionRuntime } from "../../runtime";
import { VesselDaemon } from "../vessel-daemon";
import type { ResolverHandler } from "../vessel-daemon";
// Note: __example__ is one level deeper than hosts/, so ../../ goes to src/

// ---------------------------------------------------------------------------
// 1. Build a minimal ActivityExecutor (no LLM, no trace sink for demo)
// ---------------------------------------------------------------------------

const runtime = new ExecutionRuntime({
  attachedVessels: [{ id: "echo-vessel", kind: "custom" as never, resolverIds: ["echo"] }],
});

const executor = new ActivityExecutor(runtime);

// ---------------------------------------------------------------------------
// 2. Define resolver handlers
// ---------------------------------------------------------------------------

const echoHandler: ResolverHandler = async (ctx) => {
  const body = ctx.body as Record<string, unknown>;
  return {
    resolved: true,
    shape: "echo",
    result: body.message ?? "(no message)",
    timestamp: new Date().toISOString(),
  };
};

const resolvers = new Map<string, ResolverHandler>([
  ["echo", echoHandler],
]);

// ---------------------------------------------------------------------------
// 3. Create and start VesselDaemon
// ---------------------------------------------------------------------------

const daemon = new VesselDaemon({
  port: 8299,
  vesselId: "minimal-vessel",
  vesselName: "Minimal Example Vessel",
  shapes: ["echo"],
  executor,
  resolvers,
  version: "0.0.0",
  // discoveryEndpoint and apiKey omitted — discovery registration is optional
  enforceCompositionChain: false, // relaxed for demo
});

await daemon.start();
console.log("minimal-vessel running on http://localhost:8299");
console.log("  GET  /health");
console.log("  POST /resolve  { impulse: { pointer: { type: 'echo' } }, message: '...' }");
