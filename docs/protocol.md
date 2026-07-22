# pipane Protocol Contracts

## Browser WebSocket protocol

The shared contract lives in `src/shared/ws-protocol.ts`. Every browser/server message is a JSON object containing:

- `protocolVersion`: currently `1`
- `type`: a discriminant for exhaustive dispatch
- `id`: required on client commands and correlated command responses

The server rejects invalid JSON, unsupported versions, unknown commands, and invalid fields before command dispatch. Failures use a `response` envelope with a stable error `code`, a useful `error` message, and the request id when one could be recovered.

### Client commands

The v1 command union covers installation, session subscription, prompting and steering, steering removal, abort and hard kill, compaction, model and command discovery, session statuses and authoritative session statistics, fork and fork/prompt, session naming, and process reload.

`WsAgentAdapter.send()` is generic over this union. Its result type is selected from `CommandResponseDataMap`, so a response for one command cannot be consumed as another command's data. The browser also checks that the response command matches the pending request before resolving it. Command discovery may include an active `sessionPath` or virtual-session `cwd`; the server uses that context so Pi returns the correct project-scoped prompts and skills.

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

## Rendezvous, pairing, and connection trust

The control-plane contract lives in `src/shared/rendezvous-protocol.ts` and is independently versioned by `RENDEZVOUS_PROTOCOL_VERSION`, currently `2`. The standalone rendezvous process exposes:

- `/v2/rendezvous/backend` for persistent outbound backend registration, pairing control, and signaling
- `/v2/rendezvous/browser` for one ticket-authorized browser/backend signaling route

Every frame is validated JSON containing `protocolVersion` and a `type` discriminant. Rendezvous forwards trust metadata plus ICE descriptions/candidates only; application frames never pass through it.

### Backend registration and ICE

The server sends a fresh random `challenge`. A backend responds with `register_backend`, containing its P-256 public key, metadata, and an ES256 signature over the domain-separated challenge. Rendezvous derives `backendId` from the SHA-256 fingerprint of canonical SPKI bytes and replies with `registered`, its ticket-verification public key, and short-lived ICE server credentials. Backend identity and trust files are mode `0600` and survive restarts.

The backend client reconnects its outbound WebSocket with bounded exponential backoff and repeats challenge authentication. STUN servers may be static. TURN credentials use coturn's REST convention: an expiring `timestamp:subject` username and HMAC-SHA1 credential; fresh backend credentials accompany each `connection_request` rather than expiring in a long-running peer manager. Browser and backend support relay-only ICE policy; deterministic E2E forces both peers through a local UDP TURN relay.

Backends register with `https://pipane.dev` by default. `PIPANE_RENDEZVOUS_URL` overrides that endpoint (or disables registration when set to an empty value), while `PIPANE_APP_URL` optionally overrides generated browser links. `PIPANE_BACKEND_NAME` is optional and defaults to the machine's non-fully-qualified hostname. The rendezvous executable reads comma-separated `PIPANE_STUN_URLS` and `PIPANE_TURN_URLS`, plus `PIPANE_TURN_SECRET`; durable central identity/account state defaults to `~/.config/pipane-rendezvous` or `PIPANE_RENDEZVOUS_DATA_DIR`.

### Device identity and anonymous accounts

The browser creates a non-exportable P-256 private key and stores the `CryptoKey` in IndexedDB. `deviceId` is the SHA-256 fingerprint of its canonical public SPKI. Central trust endpoints issue one-use challenges for pairing, normal connection tickets, authorized-backend discovery, device revocation, and backend-grant revocation. The device signs every challenge; no permanent bearer credential is stored in the browser.

- `POST /v1/auth/challenges`
- `POST /v1/pairings/:pairId/tickets`
- `POST /v1/connections/tickets`
- `POST /v1/accounts/backends`
- `POST /v1/revocations/devices`
- `POST /v1/revocations/backends`

The first backend-confirmed pairing creates an anonymous account. Later terminal pairings can add another browser device to the backend's owner account, or an authenticated device can add an unowned backend to its account. A signed `discover` challenge returns only that account's backend grants, with registration metadata and current reachability. A backend has one owning account in this protocol version.

### Pairing capabilities

The backend creates a 256-bit secret, stores only its hash, and publishes the opaque pair id and expiry with `open_pairing`. The QR URL has this shape:

```text
https://app.example/pair/pair_id#backend=b_id&secret=secret
```

The secret remains in the URL fragment and never reaches HTTP access logs. Capabilities expire within fifteen minutes and are single-use at both rendezvous and backend. `pipane pair` asks the running local backend for a fresh QR link. The backend validates the secret over the end-to-end DataChannel before sending `confirm_pairing`; only then does rendezvous create or extend the anonymous account and backend grant.

### Connection tickets and signaling

A browser first signs a purpose- and route-scoped central challenge. Rendezvous then signs a short-lived ticket containing ticket id, kind, account (after pairing), device id and public key, backend id, browser-generated connection id, issue time, expiry, and optional pair id. `connect_backend` requires this ticket. Rendezvous and backend each reject ticket replay, expiry, route mismatch, revoked devices, and revoked backend grants.

The browser may send only an SDP offer and the registered backend only an answer. The backend signs a `connection_binding` over the connection id, SHA-256 hashes of both exact SDP descriptions, the answer's DTLS certificate fingerprint, and ticket expiry. Rendezvous validates it against the observed signaling transcript; the browser validates the signature and pins the public key fingerprint to `backendId` before applying the answer.

### Authenticated DataChannel

The answer-side implementation accepts only a reliable ordered DataChannel with label `pipane` and subprotocol `pipane.v1`. Its first frame must contain the exact connection ticket, backend-binding signature, a device signature over both, and the pairing secret when applicable. The backend exposes the channel to `WsHandler` only after all central-ticket, local-owner, replay, revocation, device-proof, and optional pairing-secret checks pass.

Authenticated DataChannels carry the existing versioned v1 application frames through the same server connection boundary as local WebSockets. A frame router keeps those application frames isolated from semantic v2 responses on the same ordered channel. Revocation closes active rendezvous routes and matching backend peers, prevents new ticket issuance, and is retained centrally so an offline backend clears stale local ownership when it next registers.

After the unfragmented authentication exchange, the carrier transparently splits logical frames larger than 12,000 UTF-8 bytes into ordered base64 chunk envelopes no larger than 16 KiB. Browser and backend reassemble at most 64 MiB per logical frame with bounded pending-frame and outgoing-queue memory. Application v1 and semantic v2 decoders therefore continue to receive exactly one complete JSON frame regardless of the negotiated SCTP message-size limit.

### Semantic backend protocol v2

`src/shared/backend-protocol.ts` defines the carrier-neutral request protocol independently from application v1:

```text
{ v: 2, kind: "request", id, method, params }
{ v: 2, kind: "response", id, method, success, result | error }
{ v: 2, kind: "event", cursor, type, data }
```

The currently implemented semantic methods are:

- `backend.capabilities`
- `sessions.list`, `sessions.delete`, `sessions.forkMessages`, `sessions.raw`
- `files.read`, `files.upload.create`, `files.upload.append`, `files.upload.complete`
- `host.browse`, `host.mkdir`
- `settings.get`, `settings.validate`, `settings.patch`, `settings.save`
- `updates.get`, `updates.run`

Every method has runtime-validated parameters, correlated responses, stable error codes, bounded concurrency, and a bounded device-scoped completed-request cache. File uploads use bounded, offset-addressed base64 chunks so arbitrary non-image attachments can cross either local HTTP or the authenticated DataChannel, land in a private temporary backend path, and be referenced in the agent prompt. Pending browser requests retain their id across a carrier reconnect, so an in-flight mutation is resumed or answered from the cache instead of being executed twice. The backend uses one `LocalBackendApi` implementation for both the legacy local HTTP facade and semantic DataChannel requests. Remote session results are scoped to a structured `{ backendId, path }` identity; paths remain backend-local identifiers rather than authorization.

The browser's `RemoteBackendManager` maintains one client/store per active backend id, requests a fresh ticket whenever a WebRTC carrier reconnects, and never treats an arbitrary URL backend id as authorized until signed account discovery includes it. The product UI exposes reachable authorized backends and uses on-demand pairwise connections rather than a full mesh. Terminal `pipane pair` remains the no-email recovery path when browser storage is lost.

Application streaming, turn control, and session snapshots remain on validated v1 frames during parity migration. Semantic v2 is deployed beside v1 rather than changing v1's renderer-state contract in place.

## Pi subprocess RPC protocol

`src/server/pi-rpc-protocol.ts` defines the typed subset of Pi RPC commands used by pipane and validates all corresponding responses, agent/session events, and extension UI requests before they reach session state. Pi's built-in TUI commands are not forwarded by RPC `prompt`; browser equivalents such as `/session` map to explicit typed RPC operations (`get_session_stats`) instead.

`ProcessPool.sendRpc()` is generic over Pi's exported `RpcCommand`/`RpcResponse` types. Pending requests retain their expected command, and a mismatched response is rejected rather than resolving the wrong operation.

Pi RPC uses strict JSONL framing. Records are split only on LF; Unicode line separators inside JSON strings are preserved. Invalid JSON, unknown event types, malformed event payloads, and malformed command responses are logged and ignored before event dispatch.

## Compatibility policy

A breaking browser/backend application-frame change must increment `WS_PROTOCOL_VERSION`; a breaking semantic method-envelope change must increment `BACKEND_PROTOCOL_VERSION`; a breaking rendezvous control-plane change must increment `RENDEZVOUS_PROTOCOL_VERSION`. Update the corresponding decoders and contract tests. Additive fields may be introduced without a version increment when old peers can safely ignore them. New discriminants require explicit validation and exhaustive handling on both sides.
