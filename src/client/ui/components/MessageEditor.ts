import type { Model } from "@earendil-works/pi-ai";
import { icon } from "@mariozechner/mini-lit/dist/icons.js";
import { Select, type SelectOption } from "@mariozechner/mini-lit/dist/Select.js";
import { html, LitElement, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { createRef, ref } from "lit/directives/ref.js";
import { Brain, Loader2, Paperclip, Send, Square } from "lucide";
import { MAX_UPLOAD_FILE_BYTES } from "../../../shared/backend-api.js";
import { type Attachment, loadAttachment } from "../utils/attachment-utils.js";
import { i18n } from "../utils/i18n.js";
import {
	filterSlashCommands,
	slashCommandSourceLabel,
	type SlashCommandSuggestion,
} from "../../slash-commands.js";
import "./AttachmentTile.js";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

@customElement("message-editor")
export class MessageEditor extends LitElement {
	private _value = "";
	private textareaRef = createRef<HTMLTextAreaElement>();

	@property()
	get value() {
		return this._value;
	}

	set value(val: string) {
		const oldValue = this._value;
		this._value = val;
		if (!val.startsWith("/") || /\s/.test(val.slice(1))) this.slashMenuOpen = false;
		this.requestUpdate("value", oldValue);
	}

	@property() isStreaming = false;
	@property() currentModel?: Model<any>;
	@property() thinkingLevel: ThinkingLevel = "off";
	@property() showAttachmentButton = true;
	@property() showModelSelector = true;
	@property() showThinkingSelector = true;
	@property() onInput?: (value: string) => void;
	@property() onSend?: (input: string, attachments: Attachment[]) => void;
	@property() onAbort?: () => void;
	@property() onModelSelect?: () => void;
	@property() onThinkingChange?: (level: "off" | "minimal" | "low" | "medium" | "high") => void;
	@property() onFilesChange?: (files: Attachment[]) => void;
	@property() onFileUpload?: (attachment: Attachment) => Promise<string>;
	@property({ attribute: false }) slashCommands: SlashCommandSuggestion[] = [];
	/** Called before built-in key handling. Return true when the event was handled. */
	@property() onKeyDown?: (event: KeyboardEvent) => boolean;
	/** Allow steering messages to be sent while the current agent turn is running. */
	@property({ type: Boolean }) allowSendDuringStreaming = false;
	/** Pipane-owned controls rendered between the model selector and send controls. */
	@property() extraToolbarButtons?: () => TemplateResult;
	@property() attachments: Attachment[] = [];
	@property() maxFiles = 10;
	@property() maxFileSize = MAX_UPLOAD_FILE_BYTES;
	@property() acceptedTypes = "";

	@state() processingFiles = false;
	@state() isDragging = false;
	@state() private slashMenuOpen = false;
	@state() private selectedSlashCommand = 0;
	private fileInputRef = createRef<HTMLInputElement>();

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	private slashQuery(value = this.value): string | undefined {
		if (!value.startsWith("/")) return undefined;
		const query = value.slice(1);
		return /\s/.test(query) ? undefined : query;
	}

	private matchingSlashCommands(): SlashCommandSuggestion[] {
		const query = this.slashQuery();
		return query === undefined ? [] : filterSlashCommands(this.slashCommands, query);
	}

	private handleTextareaInput = (e: Event) => {
		const textarea = e.target as HTMLTextAreaElement;
		this.value = textarea.value;
		this.selectedSlashCommand = 0;
		this.slashMenuOpen = this.slashQuery() !== undefined;
		this.onInput?.(this.value);
	};

	private scrollSelectedSlashCommandIntoView(): void {
		void this.updateComplete.then(() => {
			this.querySelector<HTMLElement>(`#slash-command-option-${this.selectedSlashCommand}`)
				?.scrollIntoView({ block: "nearest" });
		});
	}

	private selectSlashCommand(command: SlashCommandSuggestion): void {
		this.value = `/${command.name}${command.acceptsArguments ? " " : ""}`;
		this.slashMenuOpen = false;
		this.selectedSlashCommand = 0;
		this.onInput?.(this.value);
		void this.updateComplete.then(() => {
			const textarea = this.textareaRef.value;
			if (!textarea) return;
			textarea.focus();
			textarea.setSelectionRange(this.value.length, this.value.length);
		});
	}

	private handleSlashMenuKeyDown(e: KeyboardEvent): boolean {
		if (!this.slashMenuOpen) return false;
		const commands = this.matchingSlashCommands();

		if (e.key === "Escape") {
			e.preventDefault();
			this.slashMenuOpen = false;
			return true;
		}
		if (commands.length === 0) return false;

		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			const direction = e.key === "ArrowDown" ? 1 : -1;
			this.selectedSlashCommand = (this.selectedSlashCommand + direction + commands.length) % commands.length;
			this.scrollSelectedSlashCommandIntoView();
			return true;
		}
		if ((e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey)
			|| (e.key === "Tab" && !e.shiftKey)) {
			e.preventDefault();
			this.selectSlashCommand(commands[this.selectedSlashCommand] ?? commands[0]);
			return true;
		}
		return false;
	}

	private handleKeyDown = (e: KeyboardEvent) => {
		// Ignore key events during IME composition (e.g. CJK input).
		if (e.isComposing || e.key === "Process") return;
		if (this.handleSlashMenuKeyDown(e)) return;
		if (this.onKeyDown?.(e)) return;

		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			const canSend = this.allowSendDuringStreaming || !this.isStreaming;
			if (canSend && !this.processingFiles && (this.value.trim() || this.attachments.length > 0)) {
				this.handleSend();
			}
		} else if (e.key === "Escape" && this.isStreaming) {
			e.preventDefault();
			this.onAbort?.();
		}
	};

	private async loadFile(file: File): Promise<Attachment> {
		const attachment = await loadAttachment(file);
		if (this.onFileUpload) attachment.uploadedPath = await this.onFileUpload(attachment);
		return attachment;
	}

	private handlePaste = async (e: ClipboardEvent) => {
		const items = e.clipboardData?.items;
		if (!items) return;

		const imageFiles: File[] = [];

		// Check for image items in clipboard
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			if (item.type.startsWith("image/")) {
				const file = item.getAsFile();
				if (file) {
					imageFiles.push(file);
				}
			}
		}

		// If we found images, process them
		if (imageFiles.length > 0) {
			e.preventDefault(); // Prevent default paste behavior

			if (imageFiles.length + this.attachments.length > this.maxFiles) {
				alert(`Maximum ${this.maxFiles} files allowed`);
				return;
			}

			this.processingFiles = true;
			const newAttachments: Attachment[] = [];

			for (const file of imageFiles) {
				try {
					if (file.size > this.maxFileSize) {
						alert(`Image exceeds maximum size of ${Math.round(this.maxFileSize / 1024 / 1024)}MB`);
						continue;
					}

					const attachment = await this.loadFile(file);
					newAttachments.push(attachment);
				} catch (error) {
					console.error("Error processing pasted image:", error);
					alert(`Failed to process pasted image: ${String(error)}`);
				}
			}

			this.attachments = [...this.attachments, ...newAttachments];
			this.onFilesChange?.(this.attachments);
			this.processingFiles = false;
		}
	};

	private handleSend = () => {
		this.onSend?.(this.value, this.attachments);
	};

	private handleAttachmentClick = () => {
		this.fileInputRef.value?.click();
	};

	private async handleFilesSelected(e: Event) {
		const input = e.target as HTMLInputElement;
		const files = Array.from(input.files || []);
		if (files.length === 0) return;

		if (files.length + this.attachments.length > this.maxFiles) {
			alert(`Maximum ${this.maxFiles} files allowed`);
			input.value = "";
			return;
		}

		this.processingFiles = true;
		const newAttachments: Attachment[] = [];

		for (const file of files) {
			try {
				if (file.size > this.maxFileSize) {
					alert(`${file.name} exceeds maximum size of ${Math.round(this.maxFileSize / 1024 / 1024)}MB`);
					continue;
				}

				const attachment = await this.loadFile(file);
				newAttachments.push(attachment);
			} catch (error) {
				console.error(`Error processing ${file.name}:`, error);
				alert(`Failed to process ${file.name}: ${String(error)}`);
			}
		}

		this.attachments = [...this.attachments, ...newAttachments];
		this.onFilesChange?.(this.attachments);
		this.processingFiles = false;
		input.value = ""; // Reset input
	}

	private removeFile(fileId: string) {
		this.attachments = this.attachments.filter((f) => f.id !== fileId);
		this.onFilesChange?.(this.attachments);
	}

	private handleDragOver = (e: DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		if (!this.isDragging) {
			this.isDragging = true;
		}
	};

	private handleDragLeave = (e: DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		// Only set isDragging to false if we're leaving the entire component
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const x = e.clientX;
		const y = e.clientY;
		if (x <= rect.left || x >= rect.right || y <= rect.top || y >= rect.bottom) {
			this.isDragging = false;
		}
	};

	private handleDrop = async (e: DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		this.isDragging = false;

		const files = Array.from(e.dataTransfer?.files || []);
		if (files.length === 0) return;

		if (files.length + this.attachments.length > this.maxFiles) {
			alert(`Maximum ${this.maxFiles} files allowed`);
			return;
		}

		this.processingFiles = true;
		const newAttachments: Attachment[] = [];

		for (const file of files) {
			try {
				if (file.size > this.maxFileSize) {
					alert(`${file.name} exceeds maximum size of ${Math.round(this.maxFileSize / 1024 / 1024)}MB`);
					continue;
				}

				const attachment = await this.loadFile(file);
				newAttachments.push(attachment);
			} catch (error) {
				console.error(`Error processing ${file.name}:`, error);
				alert(`Failed to process ${file.name}: ${String(error)}`);
			}
		}

		this.attachments = [...this.attachments, ...newAttachments];
		this.onFilesChange?.(this.attachments);
		this.processingFiles = false;
	};

	override firstUpdated() {
		const textarea = this.textareaRef.value;
		if (textarea) {
			textarea.focus();
		}
	}

	private renderSlashCommandMenu() {
		if (!this.slashMenuOpen) return "";
		const commands = this.matchingSlashCommands();
		return html`
			<div class="slash-command-menu" id="slash-command-menu" role="listbox" aria-label="Slash commands">
				${commands.length > 0
					? commands.map((command, index) => html`
						<button
							type="button"
							id=${`slash-command-option-${index}`}
							class="slash-command-option ${index === this.selectedSlashCommand ? "is-selected" : ""}"
							role="option"
							aria-selected=${index === this.selectedSlashCommand ? "true" : "false"}
							@mousedown=${(event: MouseEvent) => event.preventDefault()}
							@click=${() => this.selectSlashCommand(command)}
							@mouseenter=${() => { this.selectedSlashCommand = index; }}
						>
							<span class="slash-command-copy">
								<span class="slash-command-name" title=${`/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`}>/${command.name}${command.argumentHint ? html` <span>${command.argumentHint}</span>` : ""}</span>
								<span class="slash-command-description" title=${command.description || "No help text available"}>${command.description || "No help text available"}</span>
							</span>
							<span class=${`slash-command-source slash-command-source-${command.source}`}>
								${slashCommandSourceLabel(command.source)}
							</span>
						</button>
					`)
					: html`<div class="slash-command-empty">No matching commands</div>`}
			</div>
		`;
	}

	override render() {
		// Check if current model supports thinking/reasoning
		const model = this.currentModel;
		const supportsThinking = model?.reasoning === true; // Models with reasoning:true support thinking

		return html`
			<div
				class="bg-card rounded-xl border shadow-sm relative ${this.isDragging ? "border-primary border-2 bg-primary/5" : "border-border"}"
				@dragover=${this.handleDragOver}
				@dragleave=${this.handleDragLeave}
				@drop=${this.handleDrop}
			>
				<!-- Drag overlay -->
				${
					this.isDragging
						? html`
					<div class="absolute inset-0 bg-primary/10 rounded-xl pointer-events-none z-10 flex items-center justify-center">
						<div class="text-primary font-medium">${i18n("Drop files here")}</div>
					</div>
				`
						: ""
				}

				${this.renderSlashCommandMenu()}

				<!-- Attachments -->
				${
					this.attachments.length > 0
						? html`
							<div class="px-4 pt-3 pb-2 flex flex-wrap gap-2">
								${this.attachments.map(
									(attachment) => html`
										<attachment-tile
											.attachment=${attachment}
											.showDelete=${true}
											.onDelete=${() => this.removeFile(attachment.id)}
										></attachment-tile>
									`,
								)}
							</div>
						`
						: ""
				}

				<div class="message-editor-input-line">
					<textarea
						class="w-full bg-transparent p-4 text-foreground placeholder-muted-foreground outline-none resize-none overflow-y-auto"
						placeholder=${i18n("Type a message...")}
						rows="1"
						style="max-height: 200px; field-sizing: content; min-height: 1lh; height: auto;"
						.value=${this.value}
						@input=${this.handleTextareaInput}
						@keydown=${this.handleKeyDown}
						@paste=${this.handlePaste}
						aria-autocomplete="list"
						aria-controls="slash-command-menu"
						aria-expanded=${this.slashMenuOpen ? "true" : "false"}
						aria-activedescendant=${this.slashMenuOpen ? `slash-command-option-${this.selectedSlashCommand}` : ""}
						${ref(this.textareaRef)}
					></textarea>
					<div class="message-editor-input-actions">
						${supportsThinking && this.showThinkingSelector
							? Select({
								value: this.thinkingLevel,
								placeholder: i18n("Off"),
								options: [
									{ value: "off", label: i18n("Off"), icon: icon(Brain, "sm") },
									{ value: "minimal", label: i18n("Minimal"), icon: icon(Brain, "sm") },
									{ value: "low", label: i18n("Low"), icon: icon(Brain, "sm") },
									{ value: "medium", label: i18n("Medium"), icon: icon(Brain, "sm") },
									{ value: "high", label: i18n("High"), icon: icon(Brain, "sm") },
								] as SelectOption[],
								onChange: (value: string) => {
									const level = value as "off" | "minimal" | "low" | "medium" | "high";
									this.thinkingLevel = level;
									this.onThinkingChange?.(level);
								},
								width: "80px",
								size: "sm",
								variant: "ghost",
								fitContent: true,
							})
							: ""}
						${this.showAttachmentButton
							? html`
								<button
									class="message-input-action"
									@click=${this.handleAttachmentClick}
									?disabled=${this.processingFiles}
									title="Attach files"
									aria-label="Attach files"
								>
									${this.processingFiles
										? icon(Loader2, "sm", "animate-spin")
										: icon(Paperclip, "sm")}
								</button>
							`
							: ""}
						${!this.isStreaming || this.allowSendDuringStreaming
							? html`
								<button
									class="message-input-action message-send-action"
									@click=${this.handleSend}
									?disabled=${(!this.value.trim() && this.attachments.length === 0) || this.processingFiles}
									title=${this.isStreaming ? "Send steering message" : "Send message"}
									aria-label=${this.isStreaming ? "Send steering message" : "Send message"}
								>
									<span class="message-send-icon">${icon(Send, "sm")}</span>
								</button>
							`
							: ""}
					</div>
				</div>

				<input
					type="file"
					${ref(this.fileInputRef)}
					@change=${this.handleFilesSelected}
					accept=${this.acceptedTypes}
					multiple
					style="display: none;"
				/>

				<div class="conversation-status-bar ${this.isStreaming ? "is-streaming" : ""}">
					<span
						class="conversation-status-dot"
						title=${this.isStreaming ? "Agent working" : "Ready"}
						aria-label=${this.isStreaming ? "Agent working" : "Ready"}
					></span>
					${this.showModelSelector && this.currentModel
						? html`
							<button
								class="status-model-button"
								@click=${() => {
									this.textareaRef.value?.focus();
									requestAnimationFrame(() => this.onModelSelect?.());
								}}
								title=${`Change model (currently ${this.currentModel.id})`}
								aria-label=${`Change model (currently ${this.currentModel.id})`}
							>
								<span class="status-model-name">${this.currentModel.id}</span>
							</button>
						`
						: ""}
					${this.extraToolbarButtons?.() ?? ""}
					${this.isStreaming
						? html`
							<button
								class="status-stop-button"
								@click=${this.onAbort}
								title="Stop generation (Esc)"
								aria-label="Stop generation"
							>
								${icon(Square, "sm")}
							</button>
						`
						: ""}
				</div>
			</div>
		`;
	}
}
