/**
 * Version-tolerant thinking-level helpers.
 *
 * pipane can talk to a newer pi RPC process than the pi packages it compiles
 * against, so this module intentionally uses structural types instead of
 * importing ThinkingLevel or Model from a pinned dependency.
 */

export const THINKING_LEVEL_ORDER = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export type ThinkingLevelValue = (typeof THINKING_LEVEL_ORDER)[number];

export interface ThinkingModelLike {
	provider?: string;
	id?: string;
	modelId?: string;
	reasoning?: boolean;
	thinkingLevelMap?: Partial<Record<ThinkingLevelValue, string | null>>;
}

export interface CompactModelRef {
	provider: string;
	modelId: string;
}

/** Return the model ID from either a full RPC model or a compact session ref. */
export function getModelId(model: ThinkingModelLike | null | undefined): string | undefined {
	return model?.id ?? model?.modelId;
}

/** Compare full models and compact model refs by their stable wire identity. */
export function modelsMatch(
	a: ThinkingModelLike | null | undefined,
	b: ThinkingModelLike | null | undefined,
): boolean {
	const aId = getModelId(a);
	const bId = getModelId(b);
	return !!a && !!b && !!aId && !!bId && a.provider === b.provider && aId === bId;
}

/** Convert a full model or compact ref to the shape accepted by pi RPC. */
export function toCompactModelRef(model: ThinkingModelLike): CompactModelRef | undefined {
	const modelId = getModelId(model);
	if (!model.provider || !modelId) return undefined;
	return { provider: model.provider, modelId };
}

/**
 * Whether the model has adjustable reasoning controls.
 *
 * Modern pi models include `reasoning`; the fallbacks keep compatibility with
 * older/custom model metadata where that field may be absent.
 */
export function modelSupportsThinking(model: ThinkingModelLike | null | undefined): boolean {
	if (!model) return false;
	if (typeof model.reasoning === "boolean") return model.reasoning;
	if (model.thinkingLevelMap) return true;

	const provider = String(model.provider ?? "").toLowerCase();
	const id = String(getModelId(model) ?? "").toLowerCase();
	if (provider === "openai-codex") return true;
	if (provider === "openai" && id.startsWith("gpt-5")) return true;
	return false;
}

/**
 * Mirror current pi capability semantics:
 * - non-reasoning models support only `off`
 * - standard levels through `high` are supported unless explicitly null
 * - `xhigh` and `max` are opt-in and require a non-null map entry
 */
export function getSupportedThinkingLevels(
	model: ThinkingModelLike | null | undefined,
): ThinkingLevelValue[] {
	if (!modelSupportsThinking(model)) return ["off"];

	const map = model?.thinkingLevelMap;
	return THINKING_LEVEL_ORDER.filter((level) => {
		const mapped = map?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

/** Clamp exactly as pi does: prefer the next supported level, then search down. */
export function clampThinkingLevel(
	model: ThinkingModelLike | null | undefined,
	requested: string,
): ThinkingLevelValue {
	const available = getSupportedThinkingLevels(model);
	if (available.includes(requested as ThinkingLevelValue)) {
		return requested as ThinkingLevelValue;
	}

	const requestedIndex = THINKING_LEVEL_ORDER.indexOf(requested as ThinkingLevelValue);
	if (requestedIndex === -1) return available[0] ?? "off";

	for (let i = requestedIndex; i < THINKING_LEVEL_ORDER.length; i++) {
		const candidate = THINKING_LEVEL_ORDER[i];
		if (available.includes(candidate)) return candidate;
	}
	for (let i = requestedIndex - 1; i >= 0; i--) {
		const candidate = THINKING_LEVEL_ORDER[i];
		if (available.includes(candidate)) return candidate;
	}
	return available[0] ?? "off";
}
