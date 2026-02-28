# pi-web Architecture

> Web UI for the [pi coding agent](https://github.com/mariozechner/pi-mono). ~6,400 lines of TypeScript across client and server.

## High-Level Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Browser (Lit + Vite)                       │
│                                                                     │
│  main.ts ──► ChatPanel (@mariozechner/pi-web-ui)                   │
│     │            ▲                                                  │
│     │            │ AgentState                                       │
│     ▼            │                                                  │
│  WsAgentAdapter ─┘    session-picker   fork-modal                  │
│     │                  tool-renderers   message-renderers           │
│     │                  thinking-block-patch   dummy-storage         │
│     │                                                               │
└─────┼───────────────────────────────────────────────────────────────┘
      │ WebSocket + REST
      │
┌─────┼───────────────────────────────────────────────────────────────┐
│     ▼              Backend (Express + WS)                           │
│                                                                     │
│  server.ts                                                          │
│     │                                                               │
│     ├── REST API    GET /api/sessions          (list from JSONL)    │
│     │               GET /api/sessions/messages (read from JSONL)    │
│     │               GET /api/sessions/fork-messages                 │
│     │               DELETE /api/sessions                            │
│     │               GET /api/browse            (folder picker)      │
│     │                                                               │
│     ├── WebSocket   prompt / steer / abort / compact / fork / ...   │
│     │                                                               │
│     └── Pi Pool     N pi processes in --mode rpc (stdin/stdout)     │
│            │                                                        │
└────────────┼────────────────────────────────────────────────────────┘
             │ JSON-RPC over stdio
             ▼
      ┌─────────────┐
      │  pi CLI      │  (node pi-mono/.../cli.js --mode rpc)
      │  subprocesses│  One per concurrent turn
      └─────────────┘
```

## Core Concepts

### Session Lifecycle: Detached vs. Attached

Sessions have two modes:

| State | Description | Data source |
|-------|-------------|-------------|
| **Detached** | No pi process running. Idle session. | JSONL files on disk via REST |
| **Attached** | pi process acquired, executing a turn. | Live WebSocket event stream |
| **Virtual** | New session, no JSONL file yet. | Client-side only until first prompt |

The flow: **Virtual → Attached (first prompt creates JSONL) → Detached (turn ends) → Attached (next prompt) → Detached → …**

### Pi Process Pool

The server maintains a pool of `POOL_SIZE` (3) pre-spawned pi CLI processes in RPC mode. When a user sends a prompt:

1. An idle process is acquired (or a new one spawned)
2. It's switched to the target session via `switch_session` RPC
3. The prompt is sent; events stream back over stdout
4. On `agent_end`, the process is released back to the pool

Multiple sessions can run turns concurrently (one pi process per active turn).

### Client-Server Communication

**REST** — Stateless reads: session listing, message fetching from JSONL, directory browsing. Used for detached sessions and initial loads.

**WebSocket** — Stateful: prompting, steering, aborting, forking. The server forwards pi process events (tagged with `sessionPath`) to the single connected WS client. Only one browser connection is supported at a time (new connections replace old ones).

### Event Buffering & Dedup

A critical race exists when switching to an already-running session: messages loaded from JSONL (REST) can overlap with streaming events (WS). The adapter handles this with:

- **Disk-fetch buffering**: While `fetchMessagesFromDisk` is in-flight, streaming events are buffered and replayed after the fetch completes
- **Message dedup**: `isMessageAlreadyPresent()` checks tool_use IDs, tool_use_id, and timestamps to prevent duplicates

## File Map

### Server (`src/server/`)

| File | Lines | Purpose |
|------|-------|---------|
| `server.ts` | 822 | Express + WS server, pi process pool, RPC bridge, REST API, session watcher |

### Client (`src/client/`)

| File | Lines | Purpose |
|------|-------|---------|
| `main.ts` | 402 | App shell, ChatPanel setup, monkey-patches for steering support, render loop |
| `ws-agent-adapter.ts` | 892 | Core adapter — implements the AgentInterface contract over WebSocket. Session management, state machine, steering queues, model selection |
| `session-picker.ts` | 942 | Lit sidebar component — session list grouped by project, search, folder picker for new sessions |
| `fork-modal.ts` | 386 | Lit modal — searchable list of user messages to fork from |
| `tool-renderers.ts` | 248 | Custom renderers for Read/Write/Edit/Bash tool calls (collapsible panels with copy) |
| `message-renderers.ts` | 66 | Custom user message renderer with inline image support |
| `thinking-block-patch.ts` | 49 | Monkey-patches ThinkingBlock to show estimated token counts |
| `dummy-storage.ts` | 78 | In-memory StorageBackend — fakes provider keys so pi-web-ui's API key checks pass |
| `app.css` | ~80 | Injected send button, steering queue overlay styles |

### Tests (`src/client/*.test.ts`, `src/test/`, `e2e/`)

| File | Lines | Purpose |
|------|-------|---------|
| `ws-agent-adapter.test.ts` | 702 | Unit tests for the WS adapter state machine |
| `session-picker.test.ts` | 632 | Unit tests for session grouping, sorting, status badges |
| `rerun-duplicate.test.ts` | 950 | Regression tests for message deduplication |
| `tool-renderers.test.ts` | 71 | Basic tool renderer tests |
| `mock-agent.ts` | 145 | Test helper — MockAgent with session factories |
| `rerun-duplicate.e2e.ts` | — | Playwright E2E test for duplicate prevention |

### Config & Build

| File | Purpose |
|------|---------|
| `vite.config.ts` | Vite config with Tailwind, Node.js builtin stubs, proxy to backend |
| `dev.sh` | tmux-based dev mode (tsx watch + vite HMR) |
| `prod.sh` | Build + tmux-based prod mode (vite build + bun compile) |
| `patches/` | patch-package fixes for pi-web-ui (send button alignment, TypeScript fixes) |

## Improvement Opportunities

### 🔴 Dead / Leftover Code

1. **`mapSlashCommand()` in server.ts (lines ~270–340)** — This entire function is defined but **never called**. Slash command handling is done client-side in `ws-agent-adapter.ts`'s `handleSlashCommand()` and via the pi RPC process. The server-side mapper including `/help`, `/model`, `/resume`, `/debug`, `/export`, `/commands` is completely unreachable.

2. **`followUp()` method in ws-agent-adapter.ts** — Stub with a `TODO` comment, never implemented. The `clearFollowUpQueue()` and `setFollowUpMode()`/`getFollowUpMode()` methods are also no-ops that exist only to satisfy the interface contract.

3. **`streamFn` / `getApiKey` fields on WsAgentAdapter** — Declared as `any` with dummy values to satisfy interface checks. These are vestiges of the direct-API agent interface and are never used.

4. **`setSystemPrompt()` / `setTools()` on WsAgentAdapter** — No-op setters. The server-side pi process manages its own system prompt and tools. These exist only to fulfill the interface type.

5. **`steer()` method on WsAgentAdapter** — There is both a `steer()` method (used by the follow-up/steer interface contract) AND steering logic inside `prompt()`. The `steer()` method appears to be an unused remnant since `prompt()` already handles the "send during streaming = steer" logic.

### 🟡 Architecture Concerns

6. **Single WebSocket connection limit** — The server tracks a single `connectedWs` and replaces it on new connections. This means only one browser tab can use pi-web at a time. The sessions watcher only notifies the single connected client. No authentication or multi-user support.

7. **Monkey-patching overload in main.ts** — `patchAgentInterface()` and `patchMessageEditor()` override internal methods of upstream pi-web-ui components (sendMessage, handleKeyDown, updated lifecycle). This is brittle — any upstream update could silently break steering support. The `injected-send-btn` is created via raw DOM manipulation inside a Lit component's shadow DOM.

8. **`thinking-block-patch.ts` patches a prototype** — Overrides the `render()` method on ThinkingBlock's prototype via `customElements.get()`. Fragile and version-coupled.

9. **`prod.sh` rebuilds pi-web-ui with tsc** — The prod build shell script reaches into the dependency's source directory and recompiles it (`npx tsc -p "$WEB_UI_DIR/tsconfig.build.json"`), working around a tsgo bug. This creates an implicit build dependency on having the pi-web-ui source locally at the resolved path.

10. **Node.js builtin stubs in vite.config.ts** — A massive list of 30+ Node builtins are stubbed out with Proxy objects because pi-ai barrel exports pull in server-only code (AWS SDK, undici, etc.). This is a symptom of pi-ai not having clean browser/server export boundaries.

11. **Hardcoded `setTimeout` for process readiness** — `acquirePi()` and prompt handling use `await new Promise(resolve => setTimeout(resolve, 500))` to wait for spawned pi processes to initialize. There's no handshake or readiness signal.

12. **30-second RPC timeout** — Both client (`send()`) and server (`sendRpc()`) have hardcoded 30s timeouts. Long-running operations (large compacts, slow models) could hit this.

### 🟢 Opportunities

13. **Tool renderer duplication** — `ReadRenderer`, `WriteRenderer`, `EditRenderer`, and `BashRenderer` share ~80% of their template code. A base class or shared render function taking an icon, label, and content extraction strategy would eliminate ~150 lines.

14. **Server.ts is a monolith** — At 822 lines, it handles REST routes, WebSocket protocol, pi process pool management, RPC serialization, slash command mapping (unused), and filesystem watching. Could be split into: `routes.ts`, `ws-handler.ts`, `pi-pool.ts`, `session-watcher.ts`.

15. **No reconnection logic** — If the WebSocket drops, the client shows nothing and requires a manual page refresh. An auto-reconnect with exponential backoff would improve reliability.

16. **Session list performance** — `GET /api/sessions` reads and parses every JSONL file to extract the last user prompt timestamp on every call. The sidebar polls this on every filesystem change. Could benefit from caching or incremental updates.

17. **No type safety on WS protocol** — Both sides parse `JSON.parse(raw)` and operate on `any`. The `WsCommand` type exists on the client but the server has no corresponding type definitions. A shared protocol types package would catch mismatches at compile time.

18. **`DummyStorageBackend` could be simpler** — It implements the full `StorageBackend` interface but only the `provider-keys` fake matters. A Proxy-based approach or a one-liner override would suffice.

19. **CSS-in-JS mixed with CSS files** — `session-picker.ts` and `fork-modal.ts` use Lit's `static styles` (CSS-in-JS), while `app.css` handles the injected send button and steering queue. The tool renderers use Tailwind utility classes inline. Three different styling approaches in one app.

20. **E2E test screenshots checked in** — `e2e/screenshots/` contains 15+ PNG files that appear to be debug artifacts rather than intentional baseline snapshots. These add weight to the repo.
