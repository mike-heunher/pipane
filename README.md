# pi-web

Web UI for the pi coding agent. Uses `@mariozechner/pi-web-ui` components with a backend that manages the agent via RPC mode.

## Architecture

```
Browser (Vite + Lit)          Backend (Express + WS)         pi coding-agent
┌─────────────────┐          ┌──────────────────┐          ┌───────────────┐
│  web-ui comps   │◄──WS───►│  WebSocket relay  │◄──RPC──►│  --mode rpc   │
│  (ChatPanel)    │          │                   │  stdin/  │  (subprocess) │
└─────────────────┘          └──────────────────┘  stdout  └───────────────┘
```

## Setup

Requires `pi-mono` at `../pi-mono` with packages built (`npm run build` in pi-mono).

```bash
npm install
```

## Development

```bash
npm run dev
```

This starts:
- Backend server on http://localhost:3001
- Vite dev server on http://localhost:5173 (proxies `/ws` to backend)

Open http://localhost:5173.

## Configuration

- `PI_CWD` — Working directory for the agent (default: current directory)
- `PI_CLI` — Path to the pi CLI entry point (default: auto-resolved from pi-mono)
- `PORT` — Backend server port (default: 3001)
- API keys are read from environment variables (e.g., `ANTHROPIC_API_KEY`)
