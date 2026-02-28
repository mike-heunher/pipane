import type { Model } from "@mariozechner/pi-ai";

export function openModelPickerDialog(
	availableModels: Model<any>[],
	currentModel: Model<any> | undefined,
): Promise<Model<any> | null> {
	if (!availableModels || availableModels.length === 0) {
		window.alert("No models available from pi. Check your provider login/API keys.");
		return Promise.resolve(null);
	}

	const models = [...availableModels].sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));

	return new Promise((resolve) => {
		const overlay = document.createElement("div");
		overlay.className = "model-picker-overlay";

		const panel = document.createElement("div");
		panel.className = "model-picker-panel";

		const header = document.createElement("div");
		header.className = "model-picker-header";
		header.textContent = "Select model";

		const search = document.createElement("input");
		search.className = "model-picker-search";
		search.type = "text";
		search.placeholder = "Search provider/model...";

		const list = document.createElement("div");
		list.className = "model-picker-list";

		const footer = document.createElement("div");
		footer.className = "model-picker-footer";
		const cancel = document.createElement("button");
		cancel.className = "model-picker-cancel";
		cancel.type = "button";
		cancel.textContent = "Cancel";

		const close = (value: Model<any> | null) => {
			document.removeEventListener("keydown", onKeyDown);
			overlay.remove();
			resolve(value);
		};

		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") close(null);
		};

		const renderList = () => {
			const q = search.value.trim().toLowerCase();
			const filtered = q
				? models.filter((m) => `${m.provider}/${m.id} ${(m as any).name || ""}`.toLowerCase().includes(q))
				: models;

			list.innerHTML = "";
			if (filtered.length === 0) {
				const empty = document.createElement("div");
				empty.className = "model-picker-empty";
				empty.textContent = "No matching models";
				list.appendChild(empty);
				return;
			}

			for (const m of filtered) {
				const row = document.createElement("button");
				row.type = "button";
				row.className = "model-picker-item";
				const isCurrent = !!currentModel && currentModel.provider === m.provider && currentModel.id === m.id;
				if (isCurrent) row.classList.add("is-current");

				const label = document.createElement("div");
				label.className = "model-picker-item-label";
				label.textContent = `${m.provider}/${m.id}`;

				const meta = document.createElement("div");
				meta.className = "model-picker-item-meta";
				meta.textContent = isCurrent ? "current" : ((m as any).name || "");

				row.appendChild(label);
				row.appendChild(meta);
				row.addEventListener("click", () => close(m));
				list.appendChild(row);
			}
		};

		search.addEventListener("input", renderList);
		overlay.addEventListener("click", (e) => {
			if (e.target === overlay) close(null);
		});
		cancel.addEventListener("click", () => close(null));
		document.addEventListener("keydown", onKeyDown);

		footer.appendChild(cancel);
		panel.appendChild(header);
		panel.appendChild(search);
		panel.appendChild(list);
		panel.appendChild(footer);
		overlay.appendChild(panel);
		document.body.appendChild(overlay);

		renderList();
		requestAnimationFrame(() => search.focus());
	});
}
