# Structured browser results and prompt design

## Intent

Bring the useful Kimi Code browser contract into MusePi: the agent receives explicit browser state, bounded page-text reads, and screenshot metadata, while the user sees dedicated cards built from those same results. Preserve MusePi's existing browser backends, named-tab ownership, managed-panel visibility, and `open`/`run`/`close` callers.

## Goals

- Extend the existing `browser` tool with `status`, `read`, and `screenshot` actions.
- `status` reports availability, panel visibility, control and visible tab ids, current page identity, and a tab inventory with navigation/loading/control state where the backend can observe it.
- `read` returns rendered text blocks with `viewport`/`document` scope, `maxChars`, opaque cursor continuation, capture time, truncation state, and page identity. Reading does not scroll or load more content, and text-block ids are not element refs.
- `screenshot` uses the existing safe screenshot path and exposes its path, dimensions, byte size, and capture time alongside the image.
- Render status, text-read, and screenshot cards from structured `BrowserToolDetails`; retain the existing run timeline and raw-result access.
- Update the static browser prompt, examples, and schema so the model knows when to use state, text, element observation, screenshots, and freeform runs.
- Make prompt design a standing project requirement for every agent-facing capability.

## Non-goals

- Replacing Puppeteer `run` with a second browser tool or renaming existing tab ids.
- A full Kimi visual/element operation namespace or a new dialog protocol in this change.
- Changes to tab ownership, user takeover, backend selection, browser extensions, or the shared-Chromium importer.
- Claiming that text-block ids can drive clicks, or inventing state that a backend cannot observe.

## Constraints

- Model prompts remain static Markdown with Handlebars conditionals. Tool-schema text, prompt guidance, examples, structured results, and renderer labels must describe the same behavior.
- The managed Electron bridge is the authority for panel visibility and its tab inventory. Non-GUI backends report only supervised-tab facts; unavailable panel facts stay absent.
- Page text is bounded by `maxChars` (default 12000, range 2048–24000). Continuation uses only the returned `nextCursor`; every page makes progress, including a text block longer than the limit.
- Existing strict-schema and intent-injection behavior must continue to accept every action variant.
- UI copy is bilingual, and raw JSON remains available without replacing the dedicated presentation.

## Approaches

1. **Compatible structured actions (selected).** Add actions and typed details to the current tool, reuse `runInTab` and the managed bridge, and specialize the existing renderer. This gives the agent and user the same evidence without fragmenting lifecycle ownership.
2. **A separate Kimi-style tool.** Rejected: it would create competing tab registries, prompts, approvals, and UI contracts.
3. **Renderer-only imitation.** Rejected: attractive cards without authoritative agent fields would hide the actual capability gap.

## Design

- The managed host exposes a loopback `/musepi/state` projection alongside CDP discovery. It contains only page metadata and control/navigation state, never cookies or page text.
- The tool's `status` action consumes that projection when the managed channel is configured; otherwise it projects the supervisor's live tabs. `read` and `screenshot` require an already open named tab.
- A pure pagination helper owns cursor parsing and bounded block chunks. The page-side collector reads rendered DOM text, excludes hidden/non-content nodes, honors viewport/document scope, and reports scan truncation separately from output truncation.
- The existing run pipeline supplies operation activity, output caps, cancellation, and screenshots. Structured action results add `status`, `pageText`, and `pageScreenshot` to `BrowserToolDetails`.
- The renderer adds compact state rows, a tab table, text metadata and content, screenshot metadata and image, and collapsible raw data. Existing operation groups remain unchanged for `run`.
- `packages/coding-agent/src/prompts/tools/browser.md` teaches `status` before discovery, `read` for rendered text, `observe` for interactive refs, cursor continuation, and `screenshot` for appearance. Root `AGENTS.md` requires prompt consideration for all agent-facing capabilities.

## Verification

- Unit tests cover schema variants, status projection, cursor edge cases, and the prompt's action/pagination guidance.
- Renderer tests prove that dedicated cards consume structured fields and do not show external or fabricated state.
- Existing browser lifecycle/schema tests and focused package checks run after the change.
- A real managed-browser run exercises `status`, a two-page text read with continuation, and `screenshot`; confirm that reading does not scroll and that the cards render the returned data.
