# pipane Agent Guidelines

## Testing

Run **all** tests before committing:

```bash
npm run test && npx playwright test --timeout 60000
```

### Unit Tests (`npm run test`)

136 tests across 13 files, run via Vitest. Cover:

- **Client:** WebSocket agent adapter, tool renderers, session picker, model picker, input menu, rerun duplicate prevention, pi install flow
- **Server:** Process pool, session lifecycle state machine, session message cache, pi runtime detection, pi launch resolution, global CLI

### E2E Tests (`npx playwright test`)

10 tests across 3 files, run via Playwright (headless Chromium).

#### `e2e/real-stack.e2e.ts` — Real stack integration (4 tests)

Starts the **real pipane server** with real pi RPC processes, backed by a **mock OpenAI-compatible LLM** (`e2e/mock-llm-server.ts`). Tests the full pipeline: UI → WebSocket → pipane → pi RPC → mock LLM → back to UI.

- Sending a prompt and seeing the streamed response
- Tool call execution (read) with multi-turn continuation
- Custom tool renderer display (read header format)
- Session appearing in the picker after a prompt

Infrastructure:
- `e2e/mock-llm-server.ts` — Scenario-based mock `/v1/chat/completions` with SSE streaming. Match on user text and `hasToolResults` for multi-turn flows.
- `e2e/harness.ts` — Creates temp `PI_CODING_AGENT_DIR` with `models.json` pointing at mock, starts real pipane server.

#### `e2e/ui-screenshots.e2e.ts` — Visual golden tests (5 tests)

Uses a mock WebSocket server (no real pi process) to feed canned messages. Captures screenshots and compares against golden files in `e2e/goldens/`.

- Session list, tool renderers, input, steering queue, tool in progress

To update goldens after intentional visual changes:
```bash
npm run test:screenshots:update
```

#### `e2e/rerun-duplicate.e2e.ts` — Regression test (1 test)

Verifies that rerunning a prompt doesn't cause duplicate tool blocks in the UI (the message_end → agent_end streaming race condition).

### Adding Tests

- Unit tests go next to their source file as `*.test.ts`
- E2E tests go in `e2e/` as `*.e2e.ts`
- For real-stack e2e tests, add scenarios to `mock-llm-server.ts` and use the harness from `harness.ts`
- Build before running e2e tests: `npm run build`
