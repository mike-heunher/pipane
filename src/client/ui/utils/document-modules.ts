import type JSZip from "jszip";

let pdfModule: Promise<typeof import("pdfjs-dist")> | undefined;
let docxModule: Promise<typeof import("docx-preview")> | undefined;
let spreadsheetModule: Promise<typeof import("xlsx")> | undefined;
let zipModule: Promise<typeof JSZip> | undefined;

export async function loadPdfModule(): Promise<typeof import("pdfjs-dist")> {
	pdfModule ??= import("pdfjs-dist").then((module) => {
		module.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
		return module;
	});
	return pdfModule;
}

export function loadDocxModule(): Promise<typeof import("docx-preview")> {
	docxModule ??= import("docx-preview");
	return docxModule;
}

export function loadSpreadsheetModule(): Promise<typeof import("xlsx")> {
	spreadsheetModule ??= import("xlsx");
	return spreadsheetModule;
}

export function loadZipModule(): Promise<typeof JSZip> {
	zipModule ??= import("jszip").then((module) => module.default);
	return zipModule;
}
