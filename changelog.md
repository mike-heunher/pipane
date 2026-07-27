# Unreleased

- Fill cached conversations upward from the newest message until the viewport is occupied without moving the stable tail.
- Keep session-switch previews visually stable instead of auto-expanding history while pinned to the bottom.
- Paint a compact recent-message preview first, then progressively hydrate and expand cached conversations.
- Prefetch bounded cached conversations and avoid redundant unchanged-state renders for near-instant repeat switches.
- Restore conversations immediately from a bounded browser cache and transfer only uncached content-addressed messages on repeat switches.
- Replace full-width update banners with tiny per-backend upgrade indicators and selectable update menus.
- Add a stronger PIPANE sidebar wordmark with an outlined badge shown only on preview.pipane.dev.
- Resolve relative conversation file previews through successful write/edit calls and the conversation's verified Git worktree.
- Keep project sorting tied exclusively to the latest user prompt instead of running or assistant activity.
- Deploy isolated source-built preview rendezvous, browser, and development backend stacks without publishing npm releases.
- Guide failed WebRTC connections through browser-local hosted or self-hosted TURN relay setup with short-lived credential forwarding and relay testing.
- Acknowledge prompts as soon as Pi accepts and persists them so later transient failures do not restore duplicate composer text.

# 0.1.14 - 2026-07-26

- Restore rejected prompt text and every attachment to its conversation composer so transport failures cannot discard user input.
- Upload image attachments in bounded chunks on advertising backends while retaining legacy prompt compatibility with older hosts.
- Derive conversation user-prompt timestamps strictly from real user messages, never tool results or empty virtual sessions.
- Keep long-running prompts alive, tolerate slower model-catalog refreshes, recover cleanly from stale session races, and suppress harmless Unicode math warnings.

# 0.1.13 - 2026-07-25

- Disable the remote bandwidth optimization stack after its session-sync serialization exhausted the backend heap and terminated active sessions.
- Run production deployments in a detached systemd unit so restarting Pipane cannot terminate its own deployment.
- Flush prompts queued during manual compaction instead of dropping them when the compacted session snapshot arrives.

# 0.1.12 - 2026-07-23

- Add one-use ten-minute QR links for inviting another browser to the same pipane.dev backend workspace.
- Keep preview deployments running in a detached systemd unit while they restart the local dev backend.
- Add a source-based preview deployment for the public browser app and local dev backend without publishing npm.
- Retry transient missing-model responses while a newly started Pi worker finishes refreshing its model catalog.
- Flatten multi-server projects into one recency-sorted sidebar list while keeping per-server controls below the Pipane title.

# 0.1.11 - 2026-07-23

- Give the local dev deployment its own `piweb-dev` rendezvous identity instead of displacing production `piweb`.
- Show the unified workspace after its first reachable host connects instead of waiting for every host's ICE attempt.

# 0.1.10 - 2026-07-22

- Coalesce detached-session changes into deltas and prioritize controls while cancelling stale bulk transfers on WebSocket and WebRTC carriers.
- Merge authorized hosts and their projects into one pipane.dev session sidebar without a persistent backend top bar.

# 0.1.9 - 2026-07-22

- Register new backends with pipane.dev by default and identify them by their short hostname when no name is configured.

# 0.1.8 - 2026-07-22

- Keep large WebRTC session transfers connected and flowing when libdatachannel applies native send buffering.
- Add live remote connection diagnostics for selected ICE paths, candidates, STUN/TURN servers, RTT, throughput, and DataChannel statistics.
- Avoid a secondary libdatachannel send failure when a peer closes during asynchronous authentication rejection.
- Fragment large WebRTC DataChannel frames so multi-megabyte session snapshots do not exceed negotiated SCTP message limits or crash the backend.
- Hide pipane self-update notices when running a development commit while preserving Pi and package updates.
- Let users dismiss Pi, pipane, and managed package update notices for 24 hours.

# 0.1.7 - 2026-07-22

- Allow resizing the linked file preview pane without iframe content interrupting the drag.
- Render LaTeX in Markdown file previews and match previews to the active application theme.
- Restore each conversation's open file preview when switching between sessions.
- Support `/session` in the browser with authoritative Pi session, message, token, context, and cost statistics.
- Allow creating and opening a new folder directly from the New Project file explorer.
- Inline compact generic tool parameters with their values in readable call signatures.
- Delay sidebar pin and delete actions until a conversation has been hovered for 300 ms to prevent accidental clicks.
- Add an opt-in conversation setting that hides all but the most recent configured thinking parts.
- Keep status-bar context usage visible when per-message token usage is hidden.
- Treat stale update actions from other open clients as already complete instead of showing a contradictory error.
- Upload arbitrary non-image attachments to temporary backend files and pass their paths to the agent over local or remote connections.
- Reduce full verification runtime with VM-thread coverage, incremental typechecks, parallel E2E cases, and faster deterministic fixtures.
- Highlight the sidebar settings icon with a soft theme-colored accent tile.
- Match the settings command center palette to the active color theme and light or dark mode.
- Replace the sidebar burger and raw JSON editor with a compact categorized settings command center.
- Default sessions to the root checkout until filesystem activity identifies a linked worktree.
- Fit more slash commands in the autocomplete overview with compact single-line entries.
- Keep the conversation pinned to its live tail across background-tab layout updates unless the user explicitly scrolls away.
- Keep draft text and attachments pinned to the conversation where they were entered.
- Let users scroll away from streaming conversation and tool output without being snapped back to the bottom.
- Render HTML and styled Marked Markdown previews in script-enabled isolated iframes.
- Add persistent backend identities, authenticated rendezvous registration, signaling relay, and a browser-to-Node WebRTC DataChannel foundation.
- Add anonymous QR pairing, non-exportable browser device keys, signed one-use connection tickets, SDP/DTLS identity binding, revocation, and TURN fallback.
- Add authorized multi-backend discovery and switching, remote semantic v2 operations, reconnection, recovery guidance, and restart-safe revocation.
- Keep older completed tool calls collapsed when conversation renders recreate their DOM.
- Isolate browser/backend operations behind carrier-neutral client and frame-transport contracts.
- Add fuzzy slash-command autocomplete with inline help for built-in and Pi-provided commands.
- Allow previewing files outside the session working directory when their exact paths appear in the conversation.
- Automatically turn inline-code local file paths into clickable preview links.
- Prevent session revision recovery storms during high-volume tool output.
- Add a fast, atomic local production deployment command with health checks and rollback.
- Open linked local files from conversation output in a right-hand pane with rendered Markdown previews.
- Reduce full verification wall time with parallel checks, shared E2E harnesses, and opt-in browser artifacts.
- Constrain REST and WebSocket session file operations to canonical paths within the Pi sessions directory.
- Define, version, and runtime-validate the complete browser WebSocket and supported Pi RPC protocol contracts.
- Infer active Pi session worktrees from recent successful filesystem tool activity.
- Add actionable web notifications for pipane, Pi, and managed Pi package updates.
- Dismiss session usage details when clicking outside the popup.
- Keep conversation token usage visible across in-flight and all-zero JSONL states.
