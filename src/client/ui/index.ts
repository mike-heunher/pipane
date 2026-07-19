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

export { MessageEditor } from "./components/MessageEditor.js";
export { PiMessageList } from "./components/MessageList.js";
export { AssistantMessage, ToolMessage, UserMessage } from "./components/Messages.js";
export { ThinkingBlock } from "./components/ThinkingBlock.js";
export { formatUsage } from "./utils/format.js";
export { getMessageRenderer, registerMessageRenderer, renderMessage } from "./message-registry.js";
export { getToolRenderer, registerToolRenderer, renderTool } from "./tool-registry.js";
export type { Attachment } from "./utils/attachment-utils.js";
