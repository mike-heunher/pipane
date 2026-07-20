// Deliberate browser UI entrypoint. Keep registrations explicit so importing this
// file cannot pull in unused provider, storage, sandbox, or agent orchestration code.
import "@mariozechner/mini-lit/dist/MarkdownBlock.js";
import "./components/AttachmentTile.js";
import "./components/MessageEditor.js";
import "./components/ThinkingBlock.js";
import "./components/Messages.js";
import "./components/MessageList.js";
import "./message-renderers.js";

import { registerCodingAgentRenderers } from "./tool-renderers.js";

registerCodingAgentRenderers();
