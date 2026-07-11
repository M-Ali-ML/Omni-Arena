---
name: docs-sync
description: Keeps the docs/ folder in sync with the codebase. Use whenever code changes dramatically — new features, changed APIs or routes, schema changes, architectural shifts, renamed or removed modules. Maintains paired documentation, a classical Markdown doc in docs/md and a condensed visual HTML doc in docs/html carrying the same information.
---

# Docs Sync

## When to Update Docs

Update documentation whenever a change alters what a reader would need to know:

- New feature, endpoint, route, or CLI command
- Changed API contracts, request/response shapes, or event formats
- Database schema or migration changes
- Architectural changes (new services, moved modules, changed data flow)
- Renamed, removed, or deprecated functionality
- Changed setup, configuration, or environment variables

Small refactors, formatting, and internal-only changes that don't alter behavior do **not** require doc updates.

## The Two Doc Formats

Every documented topic lives in **two paired files with the same base name**:

| Location | Format | Purpose |
|----------|--------|---------|
| `docs/md/<topic>.md` | Markdown | Classical, complete documentation. Full prose, all details. |
| `docs/html/<topic>.html` | HTML | Visual, condensed version of the **same information**. Scannable in under a minute: diagrams, tables, callouts, cards instead of long prose. |

Both files must always carry the same information — the HTML is a denser, more visual rendering of the Markdown, never a different or partial story. When you update one, update the other in the same pass.

## Markdown Docs (`docs/md/`)

- Standard technical documentation: headings, prose, code blocks, tables.
- Link related docs to each other with relative links.
- Keep file names lowercase-hyphenated by topic, e.g. `architecture.md`, `api.md`, `data-model.md`.

## HTML Docs (`docs/html/`)

Self-contained HTML files (inline `<style>`, no build step, no external CSS/JS) that follow the **Structured Clarity** design system defined in `pre-docs/design.md`. Read that file for the full token set. Key rules:

- **Fonts:** Inter for text, Geist for code/IDs/metrics (load from Google Fonts via `<link>`).
- **Colors:** white `#FFFFFF` canvas; `#F7F7F5` surfaces for callouts and sidebars; `#37352F` charcoal for text and primary elements; `#E9E9E7` borders; `#ACABA9` muted metadata. Monochromatic base — color only for status indicators.
- **Layout:** centered content, max-width 900px, generous whitespace, 64px between major sections, 16px inside components.
- **Depth:** 1px `#E9E9E7` borders and tonal layering instead of heavy shadows; hover shadow at most `0 1px 3px rgba(0,0,0,0.05)`.
- **Shape:** 4px radius on small elements, 8px on cards and callout blocks.
- **Condensation techniques:** callout blocks for key facts and metrics, tables for enumerable data, chips for tags/statuses, simple flex/grid diagrams for architecture and data flow, `<details>` for optional depth. Prefer a diagram or table over a paragraph.

## Workflow

1. Identify which topics the code change affects (check `docs/md/` for existing files).
2. Update or create the Markdown doc first — it is the source of truth.
3. Update or create the matching HTML doc, condensing the same information visually.
4. Verify the pair: same base name, same facts, no drift. Every `docs/md/*.md` must have a `docs/html/*.html` counterpart.
5. Mention the doc updates in your summary of the code change.
