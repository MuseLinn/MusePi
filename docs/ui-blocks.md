---
layout: default
title: UI blocks
status: living
summary: The declarative, line-oriented block syntax an assistant reply may carry, and where it sits among MusePi's three answer surfaces.
scope:
  - packages/client-core/src/ui-blocks
  - packages/coding-agent/src/prompts/system/system-prompt.md
  - packages/coding-agent/src/bundled-plugins/visuals
---

# UI blocks

English | [中文](ui-blocks.zh-CN.md)

An assistant reply may carry a ```` ```ui ```` fence whose body is a **declarative component list**. The reply stays text in every other respect: blocks draw where the fence sits, they scroll with the message, and they are copied and exported with its source.

## 1. Two answer surfaces

| Surface | Shape | Use for |
| --- | --- | --- |
| ```` ```ui ```` block (in the reply) | OpenUI Lang tree, rendered by this module | Data and structure: comparisons, tables, key numbers, steps, trends — and the decisions the reply asks for |
| `widget` page | One self-contained HTML document in a null-origin sandbox | A layout that must look the way it will appear, or a choice that needs the user's conditions (`awaitAnswer`) |

There is no third, canned-card surface: the structured card types now belong to
the board, where a card persists on a canvas, and a reply that needs a table
draws one instead of reaching for a loader of the same name.

The routing is stated once, in the system prompt's *Visual answers* section, and
`packages/client-core/src/ui-blocks/guidance.test.ts` fails if the catalog and that
text drift apart.

## 2. Format: OpenUI Lang

The body is **OpenUI Lang**, the same language OpenBitFun and OpenChamber use:
one statement per line, `name = Component(args)`, the first line
`root = Stack([...])`.

````text
```ui
root = Stack([Card("迁移顺序", [Steps([{title: "影子写", status: "done"}, {title: "双读", status: "current"}, {title: "切主"}])]),
  Table(["阶段", "耗时"], [["影子写", "1 天"], ["双读", "2 天"]])])
```
````

Sharing the language is the point. Two independent products teach models the
same grammar, so a model arrives already knowing it; a MusePi-specific format
would be a dialect relearned every session. The parser
(`@openuidev/lang-core`, MIT) also supplies what a format of our own would have
to reimplement:

- **partial trees** — any prefix parses, so a block can grow while the reply streams;
- **named diagnostics** — `Card takes 2 arg(s), got 3` names the component and quotes its signature;
- **the positional-argument check** — models keep writing `Card(title: "x", …)` in a positional language, and the parser's own tokenizer turns that into one clear error instead of a cascade.

Arguments are positional. `name: value` inside a call is an error, not a style.

## 3. Catalog

`Stack Row Card Text Badge Callout KeyValue Table Steps Stat Progress BarChart LineChart`,
plus `Series` (a chart input), `Details` (folds a section), and what a reply asks
with: `Choice Input Button`.

- `Text`/`Callout` accept `markdown`, but only bold and inline code are interpreted; everything else is escaped text.
- `Table` emits a plain `<table>` so the markdown pipeline decorates it once — one table implementation, so column fitting, copy and download behave exactly as for a table written straight into the reply.
- `BarChart` takes `labels` plus `series`; `whole: true` is only honest when the values are parts that add up, so shares and a total are shown only then.
- `LineChart` needs at least two labels; a `null` value breaks its line instead of drawing through zero.
- Tones are the app's five: `neutral info success warning error`. Only `warning` and `error` earn a filled callout — five tinted banners in one reply read as stripes.

`UI_BLOCK_TYPES` in `render.ts` is the one list the renderer and the guidance test read.

## 4. Failure is visible after the reply settles

A block is diagnosed only once the reply has stopped generating. While it streams, a closed or half-written fence shows just the nodes that parsed: a token gap is not a finished program, and an error card that appears mid-answer interrupts the agent with its own repair request.

When the reply settles:

- a complete block that lost parts keeps its sound nodes, names each failed line and the parser's reason once, folds its source, and offers **one** repair action;
- a block with nothing drawable shows the same note plus its source;
- a reply that ended mid-statement (an unclosed fence, or output cut by a limit) names the truncation and folds its source, but offers no repair — quoting the prefix back cannot repair it.

Repair is one user turn: pressing the action once sends the source and reasons, and a second press or a redraw does not send again. When a settled reply holds several failed blocks, the automatic repair sends them together as one message instead of one turn per block. It also waits for the turn itself to end, not only this reply: an answer that is already final while the agent runs a later step keeps its note but is not pulled back into the loop.

Diagnostics belong to the reply body. A ```` ```ui ```` fence inside a thinking draft, a tool's output, the user's own message or a document preview draws the nodes that parse and says nothing — no truncation note, no failure note, no repair action. Those words are not the answer the agent would be asked to fix, and a draft still being written is not a broken program. `Markdown` takes this surface explicitly (`repair: "reply" | "off"`), and `"off"` is the default so a new host cannot publish diagnostics by accident.

Truncation takes no repair. This is a deliberate divergence from GenUI, which treats `parse-incomplete` as repair-worthy: GenUI's model retries inside its tool loop, while MusePi can only quote the fence prefix back as a user turn, and a prefix that stops mid-statement gives the next turn nothing to correct.

## 5. What a block asks

A reply can ask, and the answer is one message:

- `Choice(name, options, label?, multiple?)` — options with an optional description per line;
- `Input(name, label?, placeholder?, multiline?)` — free text;
- `DateInput(name, label?, time?, value?)` — a date, with a time when asked;
- `Slider(name, min, max, label?, step?, value?, unit?)` — a number in a range;
- `Button(label, variant?, value?)` — an option on one item.

A `Card` holding `Button`s is **one decision named by its card title**; every
other control is its own decision. A card of four buttons collects one answer,
not four.

Answers live in `answers.ts`, keyed by the block's hash, because the markdown
HTML is rewritten on every commit — the view re-hydrates controls from that
store after each render, so a streaming tick, a virtualization round trip or a
theme swap cannot lose a choice.

The block carries a note field and one send button, shown only once something is
chosen. Pressing it composes **one** message (`界面选择：` and one line per
decision, plus the note) and dispatches `musepi-ui-block-answer`; the desktop and
guest shells deliver it into the session as an ordinary user turn. A settled
block reads as a record: its controls dim and stop inviting presses.

## 6. Boundary

Blocks render to HTML rather than React because the markdown pipeline emits one
HTML string per message — the same constraint mermaid works under. What follows
from that:

- **No state or bindings.** A block is a picture of the answer plus the answer it
  takes; OpenUI's `$state`, queries and mutations stay unsupported on purpose
  (they need a reactive store and their own review).
- **No persistence.** A block belongs to its message; the board and the widget
  page own anything that outlives a reply.
- **Streaming draws the open fence.** A reply that has opened a ```` ```ui ````
  fence but not closed it yet has the fence split off before the markdown parse
  and rendered from the partial tree, so the block grows with the reply. The
  markdown parser never sees it, which is why it cannot be held back as an
  unfinished code block. The split stays in place after the block idles: an
  unclosed fence at the end of a settled reply is the truncated output, not
  prose. Fences are paired while scanning, so a ```` ```ui ```` written as an
  example inside another fence is not mistaken for a live block.

## 7. Blocking is a different surface

A block's answer is the user's **next** message: the turn that drew the block
has already ended, so a block can never stop the agent mid-turn. That is the
whole reason the page exists — `widget` with `awaitAnswer` keeps the call
waiting, and the question tool asks for a clarification inside the turn.

The routing follows from it: a decision the agent needs to continue belongs in
that blocking surface; a decision the user can take their time over, on several
items, with the option to explain, belongs in a block.
