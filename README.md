# ias-executor-ts

Reference TypeScript implementation of the **impulse-activity execution model**.

This repo is intended to hold the pure execution substrate:

- ontology-native primitives
- runtime-owned impulse store
- resolver registry and dispatch
- activity execution semantics
- lifecycle events and traces
- explicit ports for host effects

It is **not** a MiniBob shell. CLI, daemon/server, websocket transport, boredom, vessel registration, and deployment bootstrap belong in downstream hosts.

## Current status

Milestone A scaffold:

- ontology types
- explicit ports
- in-memory impulse store
- resolver registry
- pure activity executor
- tests that run entirely in memory

## Development loop

1. Keep the pure in-memory path working.
2. Add execution semantics before adapters.
3. Add host adapters only after the pure runtime is test-covered.
4. Attach capability-bearing vessels explicitly; do not smuggle them in as hidden built-ins.
