import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TemplateResult } from "lit";

export type MessageRole = AgentMessage["role"];

export interface MessageRenderer<TMessage extends AgentMessage = AgentMessage> {
	render(message: TMessage): TemplateResult;
}

const renderers = new Map<string, MessageRenderer<any>>();

export function registerMessageRenderer<TMessage extends AgentMessage>(
	role: TMessage["role"],
	renderer: MessageRenderer<TMessage>,
): void {
	renderers.set(String(role), renderer);
}

export function getMessageRenderer(role: MessageRole): MessageRenderer | undefined {
	return renderers.get(String(role));
}

export function renderMessage(message: AgentMessage): TemplateResult | undefined {
	return renderers.get(String(message.role))?.render(message);
}
