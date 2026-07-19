# Upstream provenance

This browser component tree is owned and maintained by pipane.

It was forked from `packages/web-ui` in `badlogic/pi-mono` at tag `v0.75.3`
(commit `a7d8dd3d`, released 2026-05-18), the final upstream web-ui release before
the workspace was removed from pi-mono.

Imported upstream files were deliberately limited to the renderer tree pipane
uses: message editor/list/components, thinking and attachments, attachment
preview/loading, formatting, and i18n. Pipane's flat server-authoritative message
model, tool renderers, compaction rendering, steering controls, and styling are
integrated directly into these sources. There is no runtime dependency on
`@mariozechner/pi-web-ui` or `@earendil-works/pi-web-ui`.

The upstream source is MIT licensed; see `LICENSE.upstream`.
