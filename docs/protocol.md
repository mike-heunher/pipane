# pipane Protocol Contracts

## Browser WebSocket protocol

The shared contract lives in `src/shared/ws-protocol.ts`. Every browser/server message is a JSON object containing:

- `protocolVersion`: currently `1`
- `type`: a discriminant for exhaustive dispatch
- `id`: required on client commands and correlated command responses

The server rejects invalid JSON, unsupported versions, unknown commands, and invalid fields before command dispatch. Failures use a `response` envelope with a stable error `code`, a useful `error` message, and the request id when one could be recovered.

### Client commands

The v1 command union covers installation, session subscription, prompting and steering, steering removal, abort and hard kill, compaction, model and command discovery, session statuses, fork and fork/prompt, session naming, and process reload.

`WsAgentAdapter.send()` is generic over this union. Its result type is selected from `CommandResponseDataMap`, so a response for one command cannot be consumed as another command's data. The browser also checks that the response command matches the pending request before resolving it.

### Server messages

The v1 server union covers:

- command success and failure responses
- initialization and Pi-install status
- global session status changes
- account and session extension statuses
- session synchronization
- effective model/thinking controls
- newly attached sessions
- session-directory change notifications

All outbound production messages use `encodeServerMessage()`, which attaches the current protocol version. The browser validates the complete envelope before mutating client state and uses exhaustive dispatch.

### Session revisions

Every `session_sync` message includes a non-negative `revision`. Revisions increase when the authoritative serialized state changes. A full snapshot establishes a revision; each following delta must be the next revision. A gap causes the browser to discard its sync base and request a fresh authoritative snapshot.

The existing hash and patch fields remain in v1. Revisions make ordering and recovery explicit without pre-empting the future semantic-update protocol.

## Pi subprocess RPC protocol

`src/server/pi-rpc-protocol.ts` defines the typed subset of Pi RPC commands used by pipane and validates all corresponding responses, agent/session events, and extension UI requests before they reach session state.

`ProcessPool.sendRpc()` is generic over Pi's exported `RpcCommand`/`RpcResponse` types. Pending requests retain their expected command, and a mismatched response is rejected rather than resolving the wrong operation.

Pi RPC uses strict JSONL framing. Records are split only on LF; Unicode line separators inside JSON strings are preserved. Invalid JSON, unknown event types, malformed event payloads, and malformed command responses are logged and ignored before event dispatch.

## Compatibility policy

A breaking WebSocket contract change must increment `WS_PROTOCOL_VERSION` and update both decoders and contract tests. Additive fields may be introduced without a version increment when old peers can safely ignore them. New discriminants require explicit validation and exhaustive handling on both sides.
