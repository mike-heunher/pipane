/**
 * Generates a synthetic session fixture for render performance testing.
 *
 * The baseline mirrors a real 190-message coding session (~760KB).
 * Pass a multiplier to scale up: `npx tsx e2e/fixtures/generate-large-session.ts 10`
 * produces ~1900 messages / ~7.6MB.
 *
 * Run: npx tsx e2e/fixtures/generate-large-session.ts [multiplier]
 */

import { writeFileSync } from "node:fs";
import path from "node:path";

const MULTIPLIER = Number(process.argv[2]) || 10;

// ── Helpers ────────────────────────────────────────────────────────────

let toolCallCounter = 0;
const nextToolCallId = () => `call_${(++toolCallCounter).toString(36).padStart(6, "0")}`;

let timestamp = 1772350060000;
const nextTimestamp = () => (timestamp += 1000 + Math.floor(Math.random() * 2000));

function repeatText(base: string, targetLen: number): string {
	if (base.length >= targetLen) return base.slice(0, targetLen);
	const repeats = Math.ceil(targetLen / base.length);
	return base.repeat(repeats).slice(0, targetLen);
}

function usage(input: number, output: number, total: number) {
	return {
		input, output, cacheRead: 0, cacheWrite: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
	};
}

// ── Realistic content ──────────────────────────────────────────────────

const CODE_TS = `\
import { createServer } from "node:http";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";

interface SessionState {
  id: string;
  path: string;
  messages: Message[];
  isStreaming: boolean;
  model: { provider: string; id: string };
}

export class SessionManager {
  private sessions = new Map<string, SessionState>();
  private watchers = new Map<string, Set<WebSocket>>();

  async createSession(cwd: string): Promise<SessionState> {
    const id = crypto.randomUUID();
    const session: SessionState = {
      id,
      path: \`/tmp/sessions/\${id}.jsonl\`,
      messages: [],
      isStreaming: false,
      model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
    };
    this.sessions.set(id, session);
    return session;
  }

  getSession(id: string): SessionState | undefined {
    return this.sessions.get(id);
  }

  broadcast(sessionId: string, event: any): void {
    const clients = this.watchers.get(sessionId);
    if (!clients) return;
    const data = JSON.stringify(event);
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }

  async loadMessages(sessionPath: string): Promise<Message[]> {
    const content = readFileSync(sessionPath, "utf8");
    return content.split("\\n").filter(Boolean).map(line => JSON.parse(line));
  }

  deleteSession(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    this.watchers.delete(id);
    return true;
  }
}
`;

const CODE_CSS = `\
.session-picker {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow-y: auto;
}

.session-item {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.session-item:hover {
  background-color: var(--accent);
}

.session-item.active {
  background-color: var(--accent);
  border-left: 2px solid var(--primary);
}

.tool-message {
  border: 1px solid var(--border);
  border-radius: 6px;
  margin: 4px 0;
  overflow: hidden;
}

.tool-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: var(--accent);
  cursor: pointer;
  font-size: 13px;
}
`;

const CODE_BASH = `\
$ npm run build

> pipane@0.1.0 build
> vite build && tsc -p tsconfig.server.json

vite v7.3.1 building for production...
transforming (847) src/client/main.ts
✓ 847 modules transformed.
dist/client/index.html                 0.77 kB │ gzip:  0.48 kB
dist/client/assets/index.css         110.38 kB │ gzip: 17.72 kB
dist/client/assets/index.js        4,227.38 kB │ gzip: 1,190.77 kB
✓ built in 6.54s

$ npm test

 ✓ src/server/process-pool.test.ts (8 tests) 234ms
 ✓ src/server/session-lifecycle.test.ts (12 tests) 89ms
 ✓ src/server/session-index.test.ts (5 tests) 16ms
 ✓ src/server/session-message-cache.test.ts (18 tests) 11ms
 ✓ src/client/tool-renderers.test.ts (12 tests) 45ms
 ✓ src/client/ws-agent-adapter.test.ts (22 tests) 156ms

 Test Files  15 passed (15)
      Tests  149 passed (149)
   Start at  11:18:07
   Duration  2.70s
`;

const CONTENT_SAMPLES = [CODE_TS, CODE_CSS, CODE_BASH];

const ASSISTANT_TEXTS = [
	"I'll read the file to understand its structure before making changes.",
	"Now I'll update the configuration to fix the issue.\n\n1. Fixed the import path\n2. Added error handling\n3. Updated the type definitions",
	"Let me run the tests to verify everything works correctly.",
	`Here's the updated implementation:\n\n\`\`\`typescript\nexport function processMessage(msg: Message): Result {\n  if (!msg.content) return { ok: false };\n  const parsed = parseContent(msg.content);\n  return { ok: true, data: parsed };\n}\n\`\`\``,
	"The build succeeded. All type checks pass and tests are green.",
	"I see the problem — the event listener is being registered multiple times. Let me fix the cleanup logic.",
	`Looking at the error:\n\n\`\`\`\nTypeError: Cannot read property 'id' of undefined\n    at SessionManager.getSession (src/server.ts:42:15)\n\`\`\`\n\nThe session lookup needs a null check.`,
	"Done. I've made the following changes across 3 files to implement the feature.",
];

const FILES = [
	"src/server/server.ts", "src/server/ws-handler.ts", "src/server/session-lifecycle.ts",
	"src/server/process-pool.ts", "src/server/rest-api.ts", "src/server/session-index.ts",
	"src/client/main.ts", "src/client/ws-agent-adapter.ts", "src/client/tool-renderers.ts",
	"src/client/session-picker.ts", "src/client/message-renderers.ts", "src/utils/helpers.ts",
	"src/types.ts", "src/config.ts", "test/server.test.ts", "test/client.test.ts",
];

const BASH_COMMANDS = [
	"npm run build", "npm test", "npx tsc --noEmit",
	"cd /Users/dev/project && cat src/server.ts", "ls -la src/",
	"grep -rn 'TODO' src/", "npm run lint", "git diff --stat",
];

// ── One "conversation turn": user → N×(assistant tool call + result) → assistant text

type Msg = Record<string, any>;

function* generateTurn(toolSpecs: Array<{ name: string; resultSize: number }>, userSize: number): Generator<Msg> {
	// User message
	const userBase = "Please refactor the session management module to support concurrent sessions. Update the WebSocket handler, fix the caching layer, update file watchers, and run the tests to make sure nothing breaks. ";
	yield {
		role: "user",
		content: [{ type: "text", text: repeatText(userBase, userSize) }],
		timestamp: nextTimestamp(),
	};

	// Tool call + result pairs
	for (let i = 0; i < toolSpecs.length; i++) {
		const { name, resultSize } = toolSpecs[i];
		const toolCallId = nextToolCallId();
		const content: any[] = [];

		// ~half have thinking
		if (i % 2 === 0) {
			content.push({ type: "thinking", thinking: "**Analyzing the code**", thinkingSignature: "sig_" + toolCallId });
		}

		// first tool call in a turn gets explanatory text
		if (i === 0) {
			content.push({ type: "text", text: ASSISTANT_TEXTS[Math.floor(Math.random() * ASSISTANT_TEXTS.length)] });
		}

		const args: Record<string, any> = {};
		const file = FILES[Math.floor(Math.random() * FILES.length)];
		switch (name) {
			case "read":
				args.path = `/Users/dev/project/${file}`;
				break;
			case "edit":
				args.path = `/Users/dev/project/${file}`;
				args.oldText = `const config = null;`;
				args.newText = `const config = createDefault();`;
				break;
			case "bash":
				args.command = BASH_COMMANDS[Math.floor(Math.random() * BASH_COMMANDS.length)];
				break;
			case "write":
				args.path = `/Users/dev/project/src/new-${toolCallCounter}.ts`;
				args.content = CODE_TS.slice(0, 500);
				break;
		}

		content.push({
			type: "toolCall",
			id: toolCallId,
			name: name.charAt(0).toUpperCase() + name.slice(1),
			arguments: args,
		});

		yield {
			role: "assistant",
			content,
			usage: usage(1000 + (i * 500), 50 + (i * 20), 0.01),
			timestamp: nextTimestamp(),
			stopReason: "tool_use",
		};

		// Tool result
		const isEdit = name === "edit";
		const isWrite = name === "write";
		const sample = CONTENT_SAMPLES[Math.floor(Math.random() * CONTENT_SAMPLES.length)];
		const text = isEdit ? "Edit applied successfully."
			: isWrite ? `File written (${resultSize} bytes).`
			: repeatText(sample, resultSize);

		yield {
			role: "toolResult",
			toolCallId,
			toolName: name.charAt(0).toUpperCase() + name.slice(1),
			isError: false,
			content: [{ type: "text", text }],
			timestamp: nextTimestamp(),
		};
	}

	// Final assistant text
	yield {
		role: "assistant",
		content: [{ type: "text", text: ASSISTANT_TEXTS[Math.floor(Math.random() * ASSISTANT_TEXTS.length)] }],
		usage: usage(3000, 200, 0.02),
		timestamp: nextTimestamp(),
		stopReason: "end_turn",
	};
}

// ── Base conversation pattern (one "unit" ≈ real session) ──────────────

interface TurnSpec {
	userSize: number;
	tools: Array<{ name: string; resultSize: number }>;
}

const BASE_TURNS: TurnSpec[] = [
	{ userSize: 130, tools: [
		{ name: "bash", resultSize: 500 }, { name: "read", resultSize: 11000 },
		{ name: "read", resultSize: 26000 }, { name: "read", resultSize: 22000 },
		{ name: "read", resultSize: 39000 }, { name: "read", resultSize: 2000 },
	]},
	{ userSize: 200, tools: [
		{ name: "edit", resultSize: 300 }, { name: "read", resultSize: 7500 },
		{ name: "edit", resultSize: 300 }, { name: "edit", resultSize: 300 },
		{ name: "bash", resultSize: 5000 },
	]},
	{ userSize: 150, tools: [
		{ name: "read", resultSize: 1200 }, { name: "read", resultSize: 9500 },
		{ name: "read", resultSize: 10500 },
	]},
	{ userSize: 180, tools: [
		{ name: "edit", resultSize: 250 }, { name: "edit", resultSize: 250 },
		{ name: "edit", resultSize: 250 }, { name: "edit", resultSize: 250 },
		{ name: "edit", resultSize: 250 }, { name: "edit", resultSize: 250 },
		{ name: "edit", resultSize: 250 }, { name: "edit", resultSize: 250 },
		{ name: "edit", resultSize: 250 }, { name: "edit", resultSize: 250 },
		{ name: "edit", resultSize: 250 }, { name: "edit", resultSize: 250 },
	]},
	{ userSize: 300, tools: [
		{ name: "bash", resultSize: 4500 }, { name: "bash", resultSize: 1000 },
		{ name: "bash", resultSize: 3500 }, { name: "bash", resultSize: 5000 },
		{ name: "bash", resultSize: 2500 }, { name: "bash", resultSize: 2000 },
		{ name: "bash", resultSize: 1500 },
	]},
	{ userSize: 250, tools: [
		{ name: "edit", resultSize: 300 }, { name: "edit", resultSize: 300 },
		{ name: "bash", resultSize: 3000 }, { name: "edit", resultSize: 300 },
		{ name: "bash", resultSize: 2000 },
	]},
	{ userSize: 400, tools: [
		{ name: "read", resultSize: 6000 }, { name: "read", resultSize: 2500 },
		{ name: "read", resultSize: 3000 }, { name: "read", resultSize: 2000 },
		{ name: "read", resultSize: 3000 }, { name: "edit", resultSize: 300 },
		{ name: "edit", resultSize: 300 }, { name: "edit", resultSize: 300 },
		{ name: "edit", resultSize: 300 }, { name: "edit", resultSize: 300 },
		{ name: "edit", resultSize: 300 }, { name: "edit", resultSize: 300 },
		{ name: "edit", resultSize: 300 },
	]},
	{ userSize: 500, tools: [
		{ name: "bash", resultSize: 51000 }, { name: "bash", resultSize: 2000 },
		{ name: "bash", resultSize: 17000 }, { name: "bash", resultSize: 2000 },
		{ name: "read", resultSize: 34000 }, { name: "read", resultSize: 1500 },
		{ name: "read", resultSize: 2500 }, { name: "edit", resultSize: 250 },
		{ name: "read", resultSize: 3000 }, { name: "edit", resultSize: 250 },
		{ name: "read", resultSize: 2800 }, { name: "edit", resultSize: 250 },
		{ name: "read", resultSize: 2700 }, { name: "edit", resultSize: 250 },
		{ name: "bash", resultSize: 5000 }, { name: "bash", resultSize: 1200 },
		{ name: "bash", resultSize: 2200 }, { name: "read", resultSize: 2000 },
		{ name: "read", resultSize: 1800 }, { name: "write", resultSize: 200 },
	]},
	{ userSize: 350, tools: [
		{ name: "read", resultSize: 14500 }, { name: "bash", resultSize: 1500 },
		{ name: "read", resultSize: 2000 }, { name: "edit", resultSize: 300 },
		{ name: "bash", resultSize: 3200 }, { name: "bash", resultSize: 1000 },
		{ name: "bash", resultSize: 600 }, { name: "bash", resultSize: 500 },
		{ name: "write", resultSize: 200 }, { name: "edit", resultSize: 300 },
		{ name: "edit", resultSize: 300 }, { name: "read", resultSize: 3000 },
		{ name: "edit", resultSize: 300 }, { name: "read", resultSize: 2500 },
		{ name: "edit", resultSize: 300 }, { name: "bash", resultSize: 2000 },
		{ name: "edit", resultSize: 300 },
	]},
];

// ── Assemble ───────────────────────────────────────────────────────────

const messages: Msg[] = [];

for (let rep = 0; rep < MULTIPLIER; rep++) {
	for (const turn of BASE_TURNS) {
		for (const msg of generateTurn(turn.tools, turn.userSize)) {
			messages.push(msg);
		}
	}
}

// ── Write ──────────────────────────────────────────────────────────────

const outPath = path.resolve(import.meta.dirname, "large-session-messages.json");
writeFileSync(outPath, JSON.stringify(messages));

const sizeKB = (Buffer.byteLength(JSON.stringify(messages)) / 1024).toFixed(0);
const sizeMB = (Buffer.byteLength(JSON.stringify(messages)) / 1024 / 1024).toFixed(1);
const roles = messages.reduce((acc, m) => ({ ...acc, [m.role]: (acc[m.role] || 0) + 1 }), {} as Record<string, number>);

console.log(`\nGenerated fixture (${MULTIPLIER}x multiplier):`);
console.log(`  Messages: ${messages.length}`);
console.log(`  Size: ${sizeKB}KB (${sizeMB}MB)`);
console.log(`  Roles: ${JSON.stringify(roles)}`);
console.log(`  → ${outPath}`);
