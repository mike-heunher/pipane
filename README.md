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

```bash
npm install
```

By default, pi-web launches `pi` from your `PATH`.

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
- `PI_CLI` — Optional CLI override. If set to a `.js/.mjs/.cjs` file, pi-web runs `node <that-file>`. If set to a binary name/path, pi-web runs it directly. Default: `pi` from `PATH`.
- `PORT` — Backend server port (default: 3001)
- API keys are read from environment variables (e.g., `ANTHROPIC_API_KEY`)
