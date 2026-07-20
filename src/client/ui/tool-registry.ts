import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { TemplateResult } from "lit";

export interface ToolRenderResult {
	content: TemplateResult;
	/** Custom renderers own their complete layout; false adds the standard card. */
	isCustom: boolean;
}

export interface ToolRenderer<TParams = any, TDetails = any> {
	render(
		params: TParams | undefined,
		result: ToolResultMessage<TDetails> | undefined,
		isStreaming?: boolean,
		runtime?: TemplateResult,
	): ToolRenderResult;
}

/** A fallback renderer receives the name because no named renderer matched. */
export interface FallbackToolRenderer {
	render(
		toolName: string,
		params: any | undefined,
		result: ToolResultMessage | undefined,
		isStreaming?: boolean,
		runtime?: TemplateResult,
	): ToolRenderResult;
}

const renderers = new Map<string, ToolRenderer>();
let fallbackRenderer: FallbackToolRenderer | undefined;

function key(toolName: string): string {
	return toolName.trim().toLowerCase();
}

export function registerToolRenderer(toolName: string, renderer: ToolRenderer): void {
	renderers.set(key(toolName), renderer);
}

export function getToolRenderer(toolName: string): ToolRenderer | undefined {
	return renderers.get(key(toolName));
}

export function setFallbackToolRenderer(renderer: FallbackToolRenderer | undefined): void {
	fallbackRenderer = renderer;
}

export function renderTool(
	toolName: string,
	params: any | undefined,
	result: ToolResultMessage | undefined,
	isStreaming?: boolean,
	runtime?: TemplateResult,
): ToolRenderResult {
	const renderer = getToolRenderer(toolName);
	if (renderer) return renderer.render(params, result, isStreaming, runtime);
	if (fallbackRenderer) return fallbackRenderer.render(toolName, params, result, isStreaming, runtime);

	throw new Error(`No renderer registered for tool: ${toolName}`);
}
