# pipane Agent Guidelines

## Completing Changes

Once a change is finished, solid, and verified, commit it to Git rather than leaving completed work uncommitted. Do not commit partial or known-broken work.

## Testing

Run the canonical full verification before committing:

```bash
npm run test:all
```

This performs, in order:

1. `npm run check` — strict TypeScript checking
2. `npm run test:coverage` — all Vitest tests plus enforced coverage thresholds
3. `npm run test:e2e` — a clean production build followed by all deterministic Playwright tests

Do not hard-code test/file counts in documentation; use the runner output when current counts are needed.

### Unit and component tests

```bash
npm run test:unit
npm run test:watch
npm run test:coverage
```

- Tests live next to source as `*.test.ts`.
- Node-only tests should declare `@vitest-environment node`; browser component tests use Happy DOM.
- Unit tests must not make unmocked network requests or emit unscoped warnings/errors.
- Mock expected failures explicitly with a scoped `vi.spyOn(console, ...)`.
- Prefer observable promises/events over fixed sleeps.

### Deterministic E2E tests

```bash
npm run test:e2e
```

Playwright tests live in `e2e/*.e2e.ts`. The command always builds first. The suite includes:

- Real-stack tests: real pipane server and pinned Pi RPC runtime backed by `e2e/mock-llm-server.ts`
- Mock-transport UI and regression tests
- Visual golden tests in `e2e/goldens/`
- Render/scroll performance checks

The real-stack harness uses an isolated `PI_CODING_AGENT_DIR`, sanitized credentials, an OS-assigned server port, and a unique readiness identity. Preserve those isolation guarantees.

To update visual goldens after an intentional visual change:

```bash
npm run test:screenshots:update
```

To stress the critical real-stack and duplicate-render regressions:

```bash
npm run test:e2e:stress
```

### Walkthrough media

The walkthrough uses real credentials/model traffic and is deliberately excluded from normal tests:

```bash
npm run test:walkthrough
```

Its source is `e2e/video-walkthrough.walkthrough.ts` and it writes README media under `e2e/screenshots/` and `e2e/videos/`.

### Adding tests

- Unit/component tests: colocate as `*.test.ts`.
- Deterministic browser tests: add `e2e/*.e2e.ts`.
- Real-stack scenarios: extend `e2e/mock-llm-server.ts` and use `e2e/harness.ts`.
- Never silence a readiness failure with `.catch(() => {})` or an arbitrary timeout.
- Coverage is a regression floor, not a substitute for meaningful behavior assertions.
