---
layout: default
title: GUI context, session hierarchy, and role models
status: living
summary: Structured quote contexts, session subtree collapse, and per-role/fallback thinking-level contracts.
scope:
  - packages/client-core/src/messages
  - packages/desktop-app/src/components
  - packages/coding-agent/src/session
---

# GUI context, session hierarchy, and role models

English | [中文](gui-context-and-session.zh-CN.md)

This document owns three related GUI contracts that were previously appended to the general GUI specs: structured context cards, session subtree collapse, and role/fallback thinking levels.

## Structured display context

`DisplayContext` is message-level presentation metadata. The model-facing text and the UI are derived from the same value; display metadata never selects model behavior.

Variants:

- `browser-annotation`: page URL, prompt, optional comment and screenshot.
- `chat-quote`: quoted message text, optional source message id and comment.
- `file-quote`: workspace path, selected text, optional language, line range and comment. An empty quote means a whole-file reference and sends only the path.

`composeDisplayContextPrompt` produces model text. Immediate send, working steer/followUp, queue, queued pop/send, optimistic echo, and persistence preserve the structured value alongside that text. Ordinary Markdown blockquotes are not contexts.

Composer chips expose source, preview, removal, and comment editing. Input is preserved verbatim while editing, including spaces and newlines; leading/trailing whitespace is trimmed only when the model prompt is composed. Browser annotation prompts without a `Comment:` line remain byte-identical.

The transcript renders a dedicated source card with a left rail, clamped quote, expansion, comment, and source-message jump when available. It never reparses an ordinary blockquote into that card.

### File and code references

FilePane's quote action emits `file-quote` rather than inserting `@path` into the draft. A selection inside the preview carries its text; without a selection the action references the whole file. `data-file-path` and `data-file-language` provide source identity for both the button and Cmd/Ctrl+L.

Line numbers are emitted only when the selection maps uniquely back to the source. Duplicate or unmappable text keeps the path without a fabricated range. The quote button prevents pointer-down from destroying the active selection.

## Session subtree collapse

A collapsed parent remains visible and represents its hidden descendants. Only child rows animate height; the parent never receives a zero-height leaving animation. Expanding restores the original children, and remounting is not required.

The shared subtree store coordinates every `SessionList` instance and persists collapsed ids. Search temporarily expands matching paths. A collapsed row uses a separate fold control inside a keyboard-operable row container, never a nested `<button>`.

The header's global action coordinates projects and subtrees:

- `setGroupsAll` takes `open`, while `setAllSubtreesCollapsed` takes `collapse`.
- With no group override (`groupsAll === null`), the actual subtree state determines the next action.
- Each tab applies its project/group state and then calls `setAllSubtreesCollapsed` in the same direction.

## Role and fallback thinking levels

Role values use `provider/id:level`, including `:auto`. `auto` is a per-role policy, not a global default and not an effort rung. It is preserved by model clamping; unsupported concrete levels fall back to `inherit`, while `off` and `auto` remain valid.

Role rows offer `inherit`, `auto`, `off`, and the resolved model's concrete efforts. Each fallback row has the same independent selector, but its ladder comes from `models.detail` for that exact selector. Changing one fallback entry replaces only its suffix and leaves the primary role and other entries unchanged.
