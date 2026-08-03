import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xmlLang from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

for (const [name, language] of Object.entries({
	bash,
	c,
	cpp,
	css,
	go,
	html: xmlLang,
	java,
	javascript,
	json,
	kotlin,
	markdown,
	php,
	python,
	ruby,
	rust,
	scss,
	sql,
	swift,
	typescript,
	xml: xmlLang,
	yaml,
})) {
	hljs.registerLanguage(name, language);
}

const MAX_HIGHLIGHT_CACHE_CHARS = 4_000_000;
const MAX_HIGHLIGHT_CACHE_ENTRIES = 256;

type HighlightCacheEntry = {
	language: string;
	code: string;
	html: string;
	size: number;
};

const highlightCacheByLanguage = new Map<string, Map<string, HighlightCacheEntry>>();
const highlightCacheLru = new Set<HighlightCacheEntry>();
let highlightCacheChars = 0;

export function highlightCode(code: string, language: string): string {
	if (!language || !hljs.getLanguage(language)) return "";
	const languageCache = highlightCacheByLanguage.get(language);
	const cached = languageCache?.get(code);
	if (cached) {
		highlightCacheLru.delete(cached);
		highlightCacheLru.add(cached);
		return cached.html;
	}

	const highlighted = hljs.highlight(code, { language, ignoreIllegals: true }).value;
	const entry: HighlightCacheEntry = {
		language,
		code,
		html: highlighted,
		size: code.length + highlighted.length,
	};
	if (entry.size > MAX_HIGHLIGHT_CACHE_CHARS) return highlighted;

	const cache = languageCache ?? new Map<string, HighlightCacheEntry>();
	if (!languageCache) highlightCacheByLanguage.set(language, cache);
	cache.set(code, entry);
	highlightCacheLru.add(entry);
	highlightCacheChars += entry.size;

	while (highlightCacheLru.size > MAX_HIGHLIGHT_CACHE_ENTRIES || highlightCacheChars > MAX_HIGHLIGHT_CACHE_CHARS) {
		const oldest = highlightCacheLru.values().next().value as HighlightCacheEntry | undefined;
		if (!oldest) break;
		highlightCacheLru.delete(oldest);
		highlightCacheByLanguage.get(oldest.language)?.delete(oldest.code);
		highlightCacheChars -= oldest.size;
	}
	return highlighted;
}
