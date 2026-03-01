interface LocalSettingsReadResponse {
	path: string;
	exists: boolean;
	errors: string[];
	settings: any;
	formatted: string;
}

interface LocalSettingsValidationResponse {
	valid: boolean;
	errors: string[];
	formatted?: string;
}

const DEFAULT_SETTINGS = {
	version: 1,
	sidebar: {
		cwdTitle: {
			filters: [],
		},
	},
};

function formatJson(content: string): string {
	const parsed = JSON.parse(content);
	return `${JSON.stringify(parsed, null, 2)}\n`;
}

function defaultSettingsJson(): string {
	return `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`;
}

export async function openLocalSettingsDialog(opts?: { onSaved?: () => void }): Promise<void> {
	const overlay = document.createElement("div");
	overlay.className = "local-settings-overlay";

	const panel = document.createElement("div");
	panel.className = "local-settings-panel";

	const header = document.createElement("div");
	header.className = "local-settings-header";
	const title = document.createElement("div");
	title.className = "local-settings-title";
	title.textContent = "Local settings";
	const closeBtn = document.createElement("button");
	closeBtn.type = "button";
	closeBtn.className = "local-settings-close";
	closeBtn.textContent = "✕";
	closeBtn.title = "Close";
	header.appendChild(title);
	header.appendChild(closeBtn);

	const pathLine = document.createElement("div");
	pathLine.className = "local-settings-path";
	pathLine.textContent = "Loading…";

	const hint = document.createElement("details");
	hint.className = "local-settings-hint";
	hint.open = false;
	hint.innerHTML = `
		<summary>Schema hint</summary>
		<div class="local-settings-hint-body">
			<p><strong>Path title pipeline:</strong> full cwd → replace HOME prefix with <code>~</code> → apply filters in order.</p>
			<pre>{
  "version": 1,
  "sidebar": {
    "cwdTitle": {
      "filters": [
        { "pattern": "^~/dev/", "replacement": "dev/" },
        { "pattern": "^dev/pipane$", "replacement": "pipane (dev)" }
      ]
    }
  }
}</pre>
			<p>Each filter supports: <code>pattern</code> (regex), <code>replacement</code> (string), optional <code>flags</code>.</p>
		</div>
	`;

	const textarea = document.createElement("textarea");
	textarea.className = "local-settings-editor";
	textarea.spellcheck = false;
	textarea.placeholder = "{}";

	const status = document.createElement("div");
	status.className = "local-settings-status";

	const footer = document.createElement("div");
	footer.className = "local-settings-footer";

	const leftActions = document.createElement("div");
	leftActions.className = "local-settings-footer-left";
	const resetBtn = document.createElement("button");
	resetBtn.type = "button";
	resetBtn.className = "local-settings-btn";
	resetBtn.textContent = "Reset defaults";
	const formatBtn = document.createElement("button");
	formatBtn.type = "button";
	formatBtn.className = "local-settings-btn";
	formatBtn.textContent = "Format";
	leftActions.appendChild(resetBtn);
	leftActions.appendChild(formatBtn);

	const rightActions = document.createElement("div");
	rightActions.className = "local-settings-footer-right";
	const validateBtn = document.createElement("button");
	validateBtn.type = "button";
	validateBtn.className = "local-settings-btn";
	validateBtn.textContent = "Validate";
	const saveBtn = document.createElement("button");
	saveBtn.type = "button";
	saveBtn.className = "local-settings-btn local-settings-btn-primary";
	saveBtn.textContent = "Save";
	const cancelBtn = document.createElement("button");
	cancelBtn.type = "button";
	cancelBtn.className = "local-settings-btn";
	cancelBtn.textContent = "Cancel";
	rightActions.appendChild(validateBtn);
	rightActions.appendChild(saveBtn);
	rightActions.appendChild(cancelBtn);

	footer.appendChild(leftActions);
	footer.appendChild(rightActions);

	panel.appendChild(header);
	panel.appendChild(pathLine);
	panel.appendChild(hint);
	panel.appendChild(textarea);
	panel.appendChild(status);
	panel.appendChild(footer);
	overlay.appendChild(panel);
	document.body.appendChild(overlay);

	let closed = false;
	let busy = false;

	const setBusy = (next: boolean) => {
		busy = next;
		textarea.disabled = next;
		resetBtn.disabled = next;
		formatBtn.disabled = next;
		validateBtn.disabled = next;
		saveBtn.disabled = next;
		cancelBtn.disabled = next;
		closeBtn.disabled = next;
	};

	const setStatus = (message: string, kind: "ok" | "error" | "info" = "info") => {
		status.className = `local-settings-status ${kind}`;
		status.textContent = message;
	};

	const close = () => {
		if (closed) return;
		closed = true;
		document.removeEventListener("keydown", onKeyDown);
		overlay.remove();
	};

	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Escape" && !busy) {
			e.preventDefault();
			close();
		}
	};

	document.addEventListener("keydown", onKeyDown);

	overlay.addEventListener("click", (e) => {
		if (e.target === overlay && !busy) close();
	});
	closeBtn.addEventListener("click", close);
	cancelBtn.addEventListener("click", close);

	formatBtn.addEventListener("click", () => {
		try {
			textarea.value = formatJson(textarea.value);
			setStatus("Formatted JSON in editor.", "ok");
		} catch (err) {
			setStatus(`Cannot format: ${err instanceof Error ? err.message : String(err)}`, "error");
		}
	});

	resetBtn.addEventListener("click", () => {
		textarea.value = defaultSettingsJson();
		setStatus("Reset editor to default settings. Click Save to persist.", "info");
	});

	const validateContent = async (): Promise<LocalSettingsValidationResponse | null> => {
		setBusy(true);
		try {
			const res = await fetch("/api/settings/local/validate", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: textarea.value }),
			});
			const data = await res.json();
			if (!res.ok) {
				setStatus(data?.error || "Validation failed", "error");
				return null;
			}
			if (data.valid) {
				if (typeof data.formatted === "string") textarea.value = data.formatted;
				setStatus("Config is valid.", "ok");
			} else {
				setStatus(data.errors?.join("\n") || "Invalid config", "error");
			}
			return data as LocalSettingsValidationResponse;
		} catch (err) {
			setStatus(err instanceof Error ? err.message : String(err), "error");
			return null;
		} finally {
			setBusy(false);
		}
	};

	validateBtn.addEventListener("click", () => {
		void validateContent();
	});

	saveBtn.addEventListener("click", async () => {
		setBusy(true);
		try {
			const res = await fetch("/api/settings/local", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: textarea.value }),
			});
			const data = await res.json();
			if (!res.ok) {
				const errors = Array.isArray(data?.errors) ? data.errors.join("\n") : data?.error || "Save failed";
				setStatus(errors, "error");
				return;
			}
			if (typeof data.formatted === "string") {
				textarea.value = data.formatted;
			}
			setStatus("Saved. JSON was auto-formatted.", "ok");
			opts?.onSaved?.();
			close();
			return;
		} catch (err) {
			setStatus(err instanceof Error ? err.message : String(err), "error");
		} finally {
			setBusy(false);
		}
	});

	setBusy(true);
	try {
		const res = await fetch("/api/settings/local");
		const data = await res.json();
		if (!res.ok) {
			setStatus(data?.error || "Failed to load settings", "error");
			pathLine.textContent = "~/.piweb/settings.json";
			textarea.value = defaultSettingsJson();
			return;
		}
		const payload = data as LocalSettingsReadResponse;
		pathLine.textContent = `${payload.path}${payload.exists ? "" : " (will be created on save)"}`;
		textarea.value = payload.formatted || JSON.stringify(payload.settings ?? DEFAULT_SETTINGS, null, 2);
		if (payload.errors?.length) {
			setStatus(payload.errors.join("\n"), "error");
		} else {
			setStatus("Edit JSON, validate, then save.", "info");
		}
	} catch (err) {
		setStatus(err instanceof Error ? err.message : String(err), "error");
		pathLine.textContent = "~/.piweb/settings.json";
		textarea.value = defaultSettingsJson();
	} finally {
		setBusy(false);
		requestAnimationFrame(() => textarea.focus());
	}
}
