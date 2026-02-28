import type { Model } from "@mariozechner/pi-ai";

type PromptFn = (message: string) => string | null | Promise<string | null>;

export async function selectModelFromAvailable(
	availableModels: Model<any>[],
	currentModel: Model<any> | undefined,
	promptFn: PromptFn,
): Promise<Model<any> | null> {
	if (!availableModels || availableModels.length === 0) return null;

	const sorted = [...availableModels].sort((a, b) => {
		const aLabel = `${a.provider}/${a.id}`;
		const bLabel = `${b.provider}/${b.id}`;
		return aLabel.localeCompare(bLabel);
	});

	const lines = sorted.map((m, i) => {
		const mark = currentModel && currentModel.provider === m.provider && currentModel.id === m.id ? " (current)" : "";
		return `${i + 1}. ${m.provider}/${m.id}${mark}`;
	});

	const reply = await promptFn(
		`Select model (number):\n\n${lines.join("\n")}`,
	);
	if (!reply) return null;
	const idx = Number.parseInt(reply.trim(), 10) - 1;
	if (!Number.isFinite(idx) || idx < 0 || idx >= sorted.length) return null;
	return sorted[idx];
}
