export function getSessionJsonlFilename(sessionPath: string | undefined): string {
	if (!sessionPath) return "";
	const normalized = sessionPath.replace(/\\/g, "/");
	return normalized.split("/").pop() || "";
}

async function copyWithFallback(text: string): Promise<boolean> {
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// fall through to legacy copy method
	}

	try {
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.setAttribute("readonly", "true");
		ta.style.position = "fixed";
		ta.style.opacity = "0";
		ta.style.pointerEvents = "none";
		document.body.appendChild(ta);
		ta.select();
		ta.setSelectionRange(0, text.length);
		const ok = typeof document.execCommand === "function" && document.execCommand("copy");
		ta.remove();
		return !!ok;
	} catch {
		return false;
	}
}

export function ensureInputMenuButton(editor: Element, getSessionPath: () => string | undefined) {
	if (editor.querySelector(".injected-menu-wrap")) return;

	const toolbars = editor.querySelectorAll(".flex.gap-2.items-center");
	const rightToolbar = toolbars[toolbars.length - 1];
	if (!rightToolbar) return;

	const wrap = document.createElement("div");
	wrap.className = "injected-menu-wrap";

	const btn = document.createElement("button");
	btn.className = "injected-menu-btn";
	btn.type = "button";
	btn.title = "Session actions";
	btn.setAttribute("aria-label", "Session actions");
	btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="18" x2="21" y2="18"></line></svg>`;

	const dropdown = document.createElement("div");
	dropdown.className = "injected-menu-dropdown";
	dropdown.hidden = true;

	const copyBtn = document.createElement("button");
	copyBtn.className = "menu-copy-session-file";
	copyBtn.type = "button";
	copyBtn.textContent = "Copy session file (.jsonl)";

	const syncCopyState = () => {
		const filename = getSessionJsonlFilename(getSessionPath());
		copyBtn.disabled = !filename;
		copyBtn.title = filename || "No saved session file yet";
		if (filename) copyBtn.textContent = "Copy session file (.jsonl)";
	};

	btn.addEventListener("click", (e) => {
		e.preventDefault();
		e.stopPropagation();
		syncCopyState();
		dropdown.hidden = !dropdown.hidden;
	});

	copyBtn.addEventListener("click", async (e) => {
		e.preventDefault();
		e.stopPropagation();
		const filename = getSessionJsonlFilename(getSessionPath());
		if (!filename) return;

		const copied = await copyWithFallback(filename);
		copyBtn.textContent = copied ? "Copied ✓" : "Copy failed";
		setTimeout(() => {
			copyBtn.textContent = "Copy session file (.jsonl)";
		}, 1200);
		dropdown.hidden = true;
	});

	document.addEventListener("click", (e) => {
		if (!wrap.contains(e.target as Node)) {
			dropdown.hidden = true;
		}
	});

	dropdown.appendChild(copyBtn);
	wrap.appendChild(btn);
	wrap.appendChild(dropdown);
	rightToolbar.insertBefore(wrap, rightToolbar.firstChild);
}
