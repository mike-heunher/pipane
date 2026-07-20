/**
 * Disable markdown strikethrough outside code spans/fences.
 * Models commonly use paired tildes for approximate values (for example
 * `~500~`), which marked otherwise renders as deleted text.
 */
export function escapeStrikethrough(content: string): string {
	return content
		.split(/(```[\s\S]*?```|`[^`\n]*`)/g)
		.map((segment, index) => {
			if (index % 2 === 1) return segment;
			return segment.replace(
				/(?<!\\)(~~|~)(?=\S)([^\n]*?\S)\1/g,
				(_match, marker: string, inner: string) => {
					const escapedMarker = marker.replaceAll("~", "\\~");
					return `${escapedMarker}${inner}${escapedMarker}`;
				},
			);
		})
		.join("");
}
