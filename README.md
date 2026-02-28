# pi-web

A clean web interface for the **pi coding agent**.

`pi-web` runs a local backend that launches `pi` in RPC mode and streams agent messages to a browser UI over WebSocket.

## Screenshot

![pi-web screenshot](docs/assets/pi-web-screenshot.png)

---

## What you get

- Chat-style UI for `pi`
- Real-time tool calls and streaming output
- Session picker and model picker
- Automatic `pi` install prompt if the CLI is missing

---

## Install from GitHub (recommended)

### 1) Clone the repo

```bash
git clone https://github.com/mike-heunher/pi-web.git
cd pi-web
```

### 2) Install dependencies

```bash
npm install
```

### 3) Start in development mode

```bash
npm run dev
```

Then open:
- Frontend: http://localhost:5173
- Backend API/WS: http://localhost:3001

> In dev mode, Vite proxies `/ws` to the backend automatically.

---

## Run in production locally

```bash
npm run build
npm run start
```

Open http://localhost:3001.

---

## Install as a global CLI

If you want to run `pi-web` directly as a command:

```bash
npm install -g pi-web
pi-web
```

---

## Requirements

- Node.js 20+
- npm 10+
- `pi` CLI available on your `PATH` (default)

If `pi` is missing, `pi-web` can prompt to install it via:

```bash
npm install -g @mariozechner/pi-coding-agent
```

---

## Configuration

Environment variables:

- `PI_CWD` — Working directory for the agent (default: current directory)
- `PI_CLI` — Override the CLI executable/path (default: `pi`)
- `PORT` — Backend port (default: `3001`)

LLM/API keys are read from standard environment variables (for example `ANTHROPIC_API_KEY`, etc.).

---

## Architecture

```mermaid
flowchart LR
  subgraph Browser[Browser]
    UI[Vite + Lit UI\n(ChatPanel / pi-web-ui)]
  end

  subgraph Server[pi-web backend]
    WS[Express + WebSocket relay\n(port 3001)]
  end

  subgraph Agent[pi coding-agent process]
    PI[pi --mode rpc\n(subprocess)]
  end

  UI <-->|WS (/ws)| WS
  WS <-->|RPC over stdin/stdout| PI
```

---

## Development

```bash
npm run dev
```

Starts both:
- Backend server on `:3001`
- Vite frontend on `:5173`

---

## Testing

Run all tests:

```bash
npm run test && npx playwright test --timeout 60000
```

---

## License

See project license information in this repository.
