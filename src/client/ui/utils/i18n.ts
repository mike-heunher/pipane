import { defaultEnglish, defaultGerman, setTranslations } from "@mariozechner/mini-lit/dist/i18n.js";

const english = {
	...defaultEnglish,
	Document: "Document",
	"Drop files here": "Drop files here",
	"Error loading file": "Error loading file",
	"Error:": "Error:",
	"Failed to display text content": "Failed to display text content",
	"Failed to fetch file": "Failed to fetch file",
	"Failed to load PDF": "Failed to load PDF",
	"Failed to load document": "Failed to load document",
	"Failed to load spreadsheet": "Failed to load spreadsheet",
	Free: "Free",
	High: "High",
	"Invalid source type": "Invalid source type",
	Low: "Low",
	Medium: "Medium",
	Minimal: "Minimal",
	"No content available": "No content available",
	"No text content available": "No text content available",
	Off: "Off",
	PDF: "PDF",
	Presentation: "Presentation",
	Remove: "Remove",
	"Request aborted": "Request aborted",
	Spreadsheet: "Spreadsheet",
	Text: "Text",
	"Type a message...": "Type a message...",
};

type PipaneMessages = { [K in keyof typeof english]: string };

declare module "@mariozechner/mini-lit/dist/i18n.js" {
	interface i18nMessages extends PipaneMessages {}
}

const german: PipaneMessages = {
	...defaultGerman,
	Document: "Dokument",
	"Drop files here": "Dateien hier ablegen",
	"Error loading file": "Fehler beim Laden der Datei",
	"Error:": "Fehler:",
	"Failed to display text content": "Textinhalt konnte nicht angezeigt werden",
	"Failed to fetch file": "Datei konnte nicht abgerufen werden",
	"Failed to load PDF": "PDF konnte nicht geladen werden",
	"Failed to load document": "Dokument konnte nicht geladen werden",
	"Failed to load spreadsheet": "Tabelle konnte nicht geladen werden",
	Free: "Kostenlos",
	High: "Hoch",
	"Invalid source type": "Ungültiger Quellentyp",
	Low: "Niedrig",
	Medium: "Mittel",
	Minimal: "Minimal",
	"No content available": "Kein Inhalt verfügbar",
	"No text content available": "Kein Textinhalt verfügbar",
	Off: "Aus",
	PDF: "PDF",
	Presentation: "Präsentation",
	Remove: "Entfernen",
	"Request aborted": "Anfrage abgebrochen",
	Spreadsheet: "Tabelle",
	Text: "Text",
	"Type a message...": "Nachricht eingeben...",
};

export const translations = { en: english, de: german };

setTranslations(translations);

export * from "@mariozechner/mini-lit/dist/i18n.js";
