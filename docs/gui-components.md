---
layout: default
title: Component catalog
status: living
summary: Index of the reusable GUI components, their ownership, and the token families they consume.
scope:
  - apps/desktop
  - packages/client-core
---

# MusePi component catalog

English | [中文](gui-components.zh-CN.md)

> This is an **index**, not a new contract: each component's rules still live in `docs/gui-design.md` (intent and standards), `docs/gui-widget-spec.md`, `docs/gui-dialog-spec.md`, and the code itself. This file only answers "does it already exist, where, and when should I use it".

## How to use this catalog

1. **Check here before writing a component.** `AGENTS.md` requires convergence: the same interaction in a second place is a signal, a third is a defect, and a fourth copy must be preceded by extracting a named primitive. If it is listed, use it.
2. **Ownership decides how you change it.** `client-core` components are shared by desktop and mobile, so both need verifying; `desktop` components serve the desktop shell only.
3. **No styles inside components.** Geometry, colour and motion read from `tokens.css`; a component file carries structure and behaviour only.

## Tokens (single source of truth)

`packages/client-core/src/styles/tokens.css` is the only authority for design variables — roughly 500+ declarations. Families and what they are for:

| Family | Purpose | Notes |
| --- | --- | --- |
| `--bg-*` / `--fg-*` | Theme surface and foreground | Derived from the active theme; all 18 presets and both schemes follow |
| `--border-*` / `--glass-hairline*` | Dividers, card hairlines | One ladder for the glass system; do not invent another |
| `--glass-*` | L1 cards / L2 floats / L3 interaction states | See `gui-glass.css`; loaded last, single authority |
| `--accent-*` | Accent family | Theme hue or an explicit override |
| `--radius-*` | Six-step radius ladder | **Literals are banned**; enforced by `scripts/check-radius-tokens.ts` |
| `--space-*` | 4px spacing rhythm | |
| `--spring-*` / `--gui-motion-*` | Motion curves and durations | Both `prefers-reduced-motion` and the motion toggle must switch off together |
| `--ease-appear` / `--ease-dismiss` / `--ease-one-take`, `--duration-one-take`, `--one-take-offset`, `--one-take-exit`, `--one-take-enter` | Arrival/exit fades and shared-surface (one-take) timing | `::view-transition-group` takes `--ease-one-take` + `--duration-one-take` (280ms); its old/new snapshots take `--one-take-exit` (120ms) / `--one-take-enter` (180ms) with the appear/dismiss pair and `--one-take-offset`. WAAPI flights read the same pair through `oneTakeMotion()` |
| `--z-*` | Stacking levels | Floats, modals and tips have their own tiers |
| `--gui-grip-*` | Splitter grip geometry and three states | See `SplitterGrip` below |
| `--gui-slider-*` | Slider hit pad, groove, fill, detents, knob, focus, hover and disabled states | Declared in `gui-chat.css` (this family's authority); one family for the in-scope sliders — see `LadderSlider` below and the exception list under it |

## Desktop shell (`apps/desktop/src/components/`)

| Component | Purpose | When to use |
| --- | --- | --- |
| `GuiSelect` | Frosted dropdown | Any enum choice; renders as the segmented control when there are two options |
| `ContextMenu` | The unified floating menu | **Every** floating menu; never invent another menu style |
| `SplitterGrip` | The pill for a resizable seam | Any new splitter; **never hand-write `<span className="gui-split-grip">`** |
| `WorkspacePageHeader` | Page-level title header (icon/title/description/actions) | Board, task center, capability center and similar pages |
| `RightRail` | The 44px right-edge icon column | The entry point to the right panel; **must render even while the panel is collapsed** |
| `ContextPanel` | The right panel itself (tabs, split, maximize) | The only container for right-panel content |
| `LadderSlider` (thinking) | The model's thinking-level slider, with `Auto` and the model ceiling | `components/LadderSlider.tsx`, under the agent tab's model card; a drag commits on release, rungs above the ceiling stay visible but unreachable. Head is one line (`Thinking level` + the current level) and there is no caption row |
| `LadderSlider` (settings) | Detent ladder for a numeric setting that declares presets | `components/settings-controls/LadderSlider.tsx`; the thumb tracks the pointer freely between detents, while a release and the arrow keys land on declared values. Same track as the thinking ladder, its own head |
| `SliderTrack` | The track both ladders render | Exported by `components/LadderSlider.tsx`; the only track markup in the product — a new ladder supplies labels and a head, never a second rail |
| `--gui-slider-*` consumers | The two custom ladders and two opted-in native ranges | Both ladders render the one `SliderTrack`; the only native `<input class="gui-range">` call sites are the notification master volume (`settings-sections/notifications.tsx`) and the companion size (`settings-sections/companion.tsx`). Scope and exceptions: see below |
| `SecretSettingsSection` | The secret vault page | `settings-sections/secret-settings.tsx`; one static state card, `密钥 · N` + add, then **one body only** (`form ? form : empty-or-rows` — never both); rows are `gui-agent-card`, controls consume `--control-*`. Never add a per-row availability chip — `secret.list` carries metadata only |
| Host bands for `SplitterGrip` | `.gui-resize-x--side` / `.gui-pane-resize-x` / `.gui-dock-handle` | The positioning layer for each of the three seams |

**Slider visual contract (`SliderTrack`, exported by `components/LadderSlider.tsx`).** Both ladders render this one component; neither carries track markup of its own. It draws the inline shape a compact effort bar wants, not a settings field: a `--gui-slider-hit` (28px) pill whose groove is `--gui-slider-track` (22px) tall and inset 3px top and bottom, with an inset hairline rather than a border (the rail's box is the measured travel span, so a border would offset the pointer math). Two layers carry it: an invisible measured rail inset by the handle radius (the pointer reads its box) and a full-bleed visible groove inset 3px inside the hit pill — a groove that stopped at the rail would read as a rail with dead ears. Detents are `--gui-slider-dot-size` dots sitting ON the groove; the fill runs from the pill's left edge through the handle, so even the first rung sits on accent, and the handle is a light disc in the page's text ink that lifts on hover and while dragged. Colours are ours (`--color-accent` for the rail and fill; the handle takes `--color-text` and the filled detents the opaque on-accent ink, because both sit on the accent) rather than a neutral handle on a foreign blue; the detents are opaque because the same ink mixed to 62% measured 2.4–3.1:1 across the light fill and 3.2–3.4:1 in the dark one — under the 3:1 floor over most of the band, so the filled rungs thinned out exactly where the ladder reads as "selected up to here"; opaque measures 3.7–5.3:1 light and 7.0–8.2:1 dark. Unreached detents take muted text ink at 55%, which measures 3.2:1 light and 4.1:1 dark against the groove — above the same floor, and still clearly weaker than a reached detent so the two states stay distinguishable. Two consequences the component must keep: there is **no caption row** under the track — every rung carries its name as its dot's `title`, behind a padded hover band, because a 4px `pointer-events: none` dot cannot be a hover target; and the thinking ladder's head is **one line**, the section label beside the current level (with `Auto · <level>` replacing the level while Auto is selected), so the value can never wrap under the label in the narrow Agent pane. Keyboard keys step through the same rungs and settle through the same clamp as a release, so a model's ceiling holds on both paths; the key handler deliberately gates on `disabled` only, because a ladder with capped top rungs still has legal rungs and refusing every key would make the control keyboard-dead on the models whose cap needs explaining. The settings ladder shares the pill, the groove, the dots and the knob, and differs only in its head: its settings row already names the setting, so the value takes the line above the track and the row keeps its 210px width.

**Slider drag contract (`useSliderDrag`, exported by `components/LadderSlider.tsx`).** Both ladders call this one hook; the settings ladder carries no pointer math of its own. The pointer drives a FRACTIONAL position — `--gui-slider-p` is `position / last`, never a rung index — so the thumb travels with the pointer instead of hopping from detent to detent. Detents attract rather than bind: the nearest reachable rung is the magnetic `target`, and while the pointer sits between detents the value readout, the highlighted detents and `aria-valuenow`/`aria-valuetext` all name that target, so the label and the screen reader never disagree. The thumb settles onto the target only when the gesture ends: a release (or a key step) restores the `--gui-slider-ease` transition on `left` and the detent pulls the thumb in, while `[data-dragging]` clears it during the gesture so the thumb never lags the pointer. `gui-motion-off` and `prefers-reduced-motion` drop the transition, so the snap lands immediately without animating. The thumb sits at the pointer from the first frame of the press — a press between two detents never jumps the thumb to one and back — and a click without travel releases onto the detent under the pointer, because the release resolves the last pointer position. Nothing is written mid-gesture — `onSettle` fires once per gesture, so the settings ladder no longer issues one `settings.set` per pointer tick and the thinking ladder keeps its one-RPC-per-gesture contract. A cancel writes nothing and restores the committed rung. Arrow keys/Home/End stay discrete steps through the same settle path, which is what makes keyboard and pointer share one visual transition. Rungs above a model's ceiling are unreachable in the track as well as the commit; a pointer parked on one reports the ceiling as its target.

**Slider scope.** The family covers the two ladders and those two native ranges. Four shipped sliders stay outside it on purpose, each in its own surface: `.gui-sketch-range` (SketchPad thickness, `gui-composer.css`), the browser device-toolbar range (`gui-browser-toolbar.css`), the screenshot stroke width (`.gui-shot-weight input`, `ScreenshotEditorDialog.tsx`) and `.tr-ui-range` (`packages/client-core/src/ui-blocks/ui-blocks.css`); the mobile `VoicePanel` rate (`packages/client-core`) is a fifth. They may adopt the family inside their own scopes; until then they must not copy its geometry by hand. Desktop voice settings have no slider at all — `tts.rate` is a schema number that renders as the rolling counter.

## Shared components (`packages/client-core/src/components/`)

Shared by desktop and mobile; changes must be verified on both.

| Group | Component | Purpose |
| --- | --- | --- |
| `shell/` | `Segmented` | Segmented control (one thumb); **every** multi-way choice uses it |
| `shell/` | `Composer` | Composer input, shared by desktop and mobile |
| `shell/` | `HeaderBar` / `MobileTabBar` / `MobileSettings` | Shell navigation |
| `shell/` | `ConfirmDialog` / `Banners` / `Toasts` / `ApprovalCard` | Confirmation, banners, toasts, approvals |
| `shell/` | `DotMatrixMark` / `MatrixLoader` / `ShinyText` / `BlurText` | Brand and loading motion |
| `common/` | `FoldRegion` | Collapsible region |
| `common/` | `SearchField` | One search field for every list filter (`field` 34px / `compact` 28px / `touch` 44px); surface from `--control-*` tokens |
| `panels/` | `BoardPanel` / `FilePanel` / `ScheduledPanel` / `VoicePanel` / `WorkspacePanel` | Right-panel surfaces |
| `agents/` | `AgentsPanel` / `AgentDrawer` | Subagent HUD and detail |
| `marketplace/` | `MarketplaceGrid` / `MarketplaceCard` / `MarketplacePanel` | Marketplace grid (the capability page re-skins it, never copies it) |
| `charts/` | `BarChart` / `LineChart` / `Donut` / `Gauge` / `KLine` / `Sparkline` | Charts |
| `progress/` | `ProgressMeter` | Progress |
| `transcript/` | `BranchSummaryDivider` | The inherited-history boundary; leads with the shared `GitFork` glyph and keeps the label as its accessible name |
| — | `image-lightbox` / `image-morph` / `image-zoom` | Image viewing |

## Search (`packages/client-core/src/`)

- **`SearchField`** (`components/common/SearchField.tsx`) is the only search input — see its row above. Matching is never the field's job.
- **`TextSearchIndex`** (`lib/text-search.ts`) is the only matcher behind a search field:
  - **Two key kinds.** `fuzzy` holds short identifying text (names, titles, labels, readable ids) and matches as a substring or a word-start subsequence; `substring` holds long text and opaque ids (descriptions, config keys, paths, UUIDs) and matches only as a contiguous substring.
  - **One fold.** Both key kinds and the query ignore case, width (NFKC), U+0300–U+036F diacritics and letter strokes (`ł`, `ø`); marks that change a letter, such as kana voicing, stay. So `web` finds `ＷＥＢ` and `lodz` finds `Łódź`.
  - **Word-start fuzzy.** A subsequence must start at a word start — after a separator, at a camel-case hump, or at any CJK character — so `cpt` finds `Compact` while `fab` does not match inside `Refactor build`.
  - **Terms and tiers.** The query splits on whitespace and every term must match some key. A term scores its best tier: fuzzy exact, fuzzy prefix, fuzzy substring, fuzzy word-start subsequence, then a substring-key hit; equal totals keep build order. `search` returns the build list itself for a blank query; `rank` returns scored hits and nothing for a blank query.
  - **Every language is a key.** Pass the translated and source text — the settings search passes en-US, zh-CN and the active locale — so a query in either language hits.
  - **Immutable and DOM-free.** Build an index when the list or a label's language changes, not per keystroke; the settings search caches one index per rows array and locale, and the palette builds small per-query indexes.

**Consumers:** the settings nav and its schema-row results (`apps/desktop/src/lib/settings-search.ts`) and the command palette (`apps/desktop/src/components/CommandPalette.tsx` — commands in both languages, settings pages and rows, session titles). Session content search (`session.search`) and the plugin market keep their own indexes and are not routed through this primitive.

## Hover cards (one recipe)

Both sidebar hover cards — the session card (`SessionHoverCard.tsx`, 288px) and the project card (`ProjectHoverCard.tsx`, 240px) — are **one** recipe in `gui-chrome.css`, `.gui-hover-card` plus its `-title` / `-meta` / `-dot` / `-rows` / `-row` / `-icon` / `-label` / `-text` / `-chip` parts. The card blocks that follow it declare only what their content changes; a new popover starts from these parts instead of copying six declarations.

| Part | Value | Why |
| --- | --- | --- |
| Surface | L2 glass: `color-mix` overlay + `backdrop-filter` + the six-layer shadow | Same layer as `.gui-menu-popup`; never a second glass family |
| Title | `--ui-font-size`, weight 600, `line-height: 1.35` | One title size for both cards |
| Meta line | `--ui-font-size-xs`, 2px dots, one accent chip | A short readable fact line, not a label/value stack |
| Row box | `--ui-font-size-xs`, `var(--color-text-muted)` with the name cell at `var(--color-text)`, 6px gap, `3px 4px`, 12px icon at 0.75, one-line ellipsis | The 4px inline padding is the hit area and the text grid. The row and its icon are muted; only the name is full-strength — a card-specific rule must not re-declare `color` on the row, or it ties on specificity and wins on source order |
| Row group | `.gui-hover-card-rows`: `1px` step | A stack of facts scans as one grid instead of five separate blocks |
| Entrance | Two-phase: base `opacity: 0`, `--entered` flips opacity to 1 **and** starts `gui-hover-card-in`, whose keyframe animates **transform only** (140ms `--spring`); direction from `--gui-hover-card-shift-x` / `-y` | A one-gesture slide on a two-phase reveal. Animating opacity on a `backdrop-filter` surface makes Chromium skip backdrop sampling on the real compositor, so the frost vanishes for the whole fade (see below) |
| Hidden state | The base `opacity: 0`, cancelled by `--entered` | With `animation: none` under reduced motion or `.gui-motion-off`, `--entered` has already set opacity 1, so the card lands visible instead of stuck transparent |
| Reduced motion | `animation: none` on `.gui-hover-card--entered` under `prefers-reduced-motion` and `.gui-motion-off` | The slide is dropped; the opacity flip is not an animation, so it still applies |

**What legitimately differs by content:** width (288px with a two-line title clamp for session titles; 240px with a single-line title for a project name), the list (the project card's directory list has its own height cap and scrolls, clamped by `fitProjectCard`; the session card is a short stack of fact rows that never scrolls), and the entrance direction (the session card slides in from the row's right, the project card from above or below, including its `--above` flip).

**Hit areas are honest.** A row carries `.gui-hover-card-row--action` only when it does something, and the element that paints the wash is the element that acts. The project card's directory row **is** a `<button>` filling the row box (icon, name, primary chip and a decorative trailing arrow inside it), so the wash covers exactly the 212px that navigates — clicking the left padding or the blank space beside the name opens the folder, the cursor is a pointer, and the focus ring is on the row. The session card's rows are read-only and its card is `pointer-events: none`, so nothing inside it can hover at all. `.gui-hover-card-chip` is shared (primary directory / session mode) and both cards keep their own chip label source.

**Why the entrance does not fade.** The recipe's hidden state is a base `opacity: 0`, and `--entered` flips it to 1 in one step while the keyframe animates transform only. That is the repo's measured rule for every frosted float layer: animating opacity on a `backdrop-filter` element makes Chromium's real-screen compositor skip backdrop sampling, so the card reads as plain translucency for the whole fade and snaps to frosted only when the animation ends. CDP screenshots use offscreen compositing and still show blur, which is why this cannot be caught by a style probe — see `docs/gui-design.md` (two-phase enter) and `docs/gui-implementation.md` §6.5, and the two shipped examples (`.gui-menu-popup`, `.gui-board-focus`). The recipe is what every future popover copies, so it carries the rule rather than re-deriving it.

**The opaque fallback is part of the recipe.** `packages/client-core/src/styles/overlay-fallback.css` loads after every component sheet and replaces the translucent fill with `--color-surface-raised` plus the sheen, dropping `backdrop-filter`, in three situations: `[data-platform="win32"]`, `prefers-reduced-transparency: reduce`, and `@supports not (backdrop-filter: …)`. It names **`.gui-hover-card`**, not either card, so a third card on the recipe is covered without editing that file. The win32 and reduced-transparency branches are proved for both cards by computed style in `hover-card-geometry.test.ts` (and the test also proves the glass state survives off those branches); the `@supports` branch cannot be forced in a supporting browser but shares the same selector list.

Contracts: `apps/desktop/test/project-hover-card.test.tsx` (state, portal, flip), `apps/desktop/test/session-fork-badge.test.tsx` (the session card's fork line), and `apps/desktop/test/hover-card-geometry.test.ts` (real Chromium: both cards' padding, row step, title clamp, the transform-only entrance, the two-phase pending frame, reduced motion landing immediately, the whole directory row being clickable, and the opaque fallback on win32 / reduced transparency).

### The convergence rule behind it

The user's report was not "make the session card prettier" but "why does the project card look more finished?" — a **finish divergence** between two siblings built at different times. The rule it produced, which applies to the next popover as much as to these two:

1. **A newer component that reads as more finished sets the reference.** When a newly built surface visibly out-finishes an older sibling, the older one converges on it; the newer one's choices become the starting point for the next surface instead of being rediscovered. Divergence in finish between siblings is a defect even when both are individually acceptable.
2. **Name the ingredients, not the taste.** The three that produced this difference are concrete and reusable: a **dense row grid with honest hit areas** (a real vertical step and a 4px inline pad, on the element that acts), **one structured meta line** (dot separators plus one accent chip) instead of a label/value stack, and **a one-gesture slide on a two-phase reveal** — the card mounts at `opacity: 0` with no animation, `--entered` flips opacity in one step, and the keyframe slides it 4–6px. Copy the ingredient, not the pixels; note that the slide, not a fade, is the ingredient — animating opacity on frosted glass breaks the frost (see *Why the entrance does not fade* above).
3. **Extract on the second copy, not the fourth.** The two cards had already copied the same six declarations into one file. The recipe (`.gui-hover-card` + its parts) is that extraction, so a third hover card consumes it rather than adding a third copy.
4. **Counter-rule: convergence never restyles behaviour.** A row gets a hover affordance only when clicking it does something. The project card's directory rows open, the session card's rows are read-only, and that asymmetry is correct and stays — the row grid converged, the hit area did not. Convergence is about finish, never about giving a surface an action it does not have.

## Overflow contract

A scroll container declares **the axis it uses and the axis it must not use**. Setting only one of `overflow-x` / `overflow-y` leaves the other computing to `auto` (the CSS spec forbids `visible` as a companion), so a vertical list silently becomes a horizontal scroller too — and the first row wider than the content box grows a scrollbar under content that was already complete. That shipped on the project hover card ("内容明明显示完整却出现了不该出现的横向滚动") and appeared in ~70 other desktop rules, which is why this is a class rule with a guard rather than a card patch.

1. **One axis scrolls; the counterpart is explicit.** `overflow-y: auto; overflow-x: clip;` is the standard vertical-list shape. Use `clip` rather than `hidden` when the container may hold `position: sticky` children: `hidden` makes the box a scroll container, which silently breaks the sticky offset, while `clip` does not.
2. **`nowrap` content ellipsizes or wraps.** A single-line row that must not wrap gets `overflow: hidden; text-overflow: ellipsis` on the text cell plus a `title` carrying the full value. It never relies on horizontal scrolling to reveal something already shown.
3. **Horizontal scrolling only where it is declared and named.** A genuinely horizontal container (tab strip, code block, data table) declares both axes and is listed by selector in `scripts/check-overflow-axis.ts` → `HORIZONTAL_SCROLLERS` with a one-line reason. The list is the single source of truth; this document names it instead of copying it, so an entry cannot go stale here while the guard still enforces it.
4. **Shorthand is fine.** `overflow: hidden` sets both axes by definition, so it needs no counterpart.

The guard fails on: a rule that declares one axis alone, a horizontal scroller that is not on the list, and a list entry that no longer scrolls sideways or no longer exists (a stale exemption is how an allowlist turns into a place bugs hide). Contracts: `scripts/check-overflow-axis.ts` + `scripts/check-overflow-axis.test.ts`; the card's real-Chromium proof (both `scrollWidth === clientWidth` and its placement beside the sidebar) is `apps/desktop/test/project-hover-card-geometry.test.ts`.

## Dialogs and boards

- Every dialog goes through `DialogFrame`; rules in `docs/gui-dialog-spec.md` (size tiers, scroll container, focus, modifier specificity).
- Board and inline card geometry, registration parity and source text rules are in `docs/gui-widget-spec.md`.

## Known gaps (recorded, not resolved)

Building this catalog surfaced two places that are still not converged. Keep them in mind when changing things:

1. **Interaction-state naming is not unified.** `--glass-hover*` covers generic hover, while component-specific three-state sets like `--gui-grip-*` are newer; a new component must decide whether to reuse the former or open a family by the naming rule.
2. **CSS contract tests cover only radius, the grip and the slider family.** Outside `scripts/check-radius-tokens.ts`, `test/splitter-grip.test.ts` and `test/slider-tokens.test.ts`, most component styles have no guard.

When adding a component, update its row here and record the contract it follows in `docs/gui-design.md`.

## Guards (code beats prose)

A prose rule is advisory; a check is a contract. Where a standard can be verified mechanically, it has a guard wired into `bun run check:tools`, so breaking it fails CI rather than review:

| Guard | Enforces |
| --- | --- |
| `scripts/check-radius-tokens.ts` | No literal `border-radius`; every `--radius-*` is defined |
| `scripts/check-overflow-axis.ts` | A stylesheet rule sets both overflow axes (or the shorthand); a horizontal scroller is named in the guard's allowlist with a reason; no stale allowlist entry |
| `scripts/check-disabled-hover.ts` | A class with a `:disabled` rule excludes the pointer in `:hover` (`:hover:not(:disabled)`) or resets it (`:disabled:hover`); generated asset bundles are exempt |
| `scripts/check-splitter-grip.ts` | Only `SplitterGrip.tsx` may emit the grip class; the drag state keys off the pill's own `data-resizing`, never the global `body.gui-resizing`; the retired `.gui-resize-grip` stays gone |
| `test/splitter-grip.test.ts` | The grip primitive's tokens, three states, and seam geometry |
| `test/slider-tokens.test.ts` | The shared slider token family, the one `SliderTrack`, the native range colours and the model disclosure's focus contract |
| `test/thinking-ladder-geometry.test.ts` | Real-cascade geometry: the one-line head at the narrowest Agent pane, the absent caption row, the 28px pill with its inset groove, the fill/knob relationship, and that capped and `off` rungs stay named |

A new guard must be proven to fail on the unfixed tree before it is trusted (see `.agents/rules/testing.md`: a guard that passes both ways guards nothing).
