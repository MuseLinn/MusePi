---
layout: default
title: Next-input suggestions
status: living
summary: How MusePi predicts the user's next message after a turn and offers it in an empty composer.
scope:
  - packages/coding-agent/src/bundled-plugins/prompt-suggestion
  - packages/coding-agent/src/session/prompt-suggestion.ts
  - packages/coding-agent/src/daemon/session-host.ts
  - packages/client-core/src/lib/prompt-suggestion.ts
  - apps/desktop/src/components/Composer.tsx
---

# Next-input suggestions

English | [中文](input-suggestions.zh-CN.md)

An input suggestion is one predicted next user message, offered as the placeholder of an empty composer and accepted with `Tab` or `→`. It is a convenience only: accepting fills the draft, the user still sends, and ignoring it costs nothing.

The mechanism is adapted from OpenBitFun's prompt-suggestion pipeline, re-expressed on MusePi's existing ephemeral side channel instead of a new model path.

## 1. Why it reuses the turn — and its model

The prediction re-runs the just-finished turn with one extra instruction appended, through `AgentSession.runEphemeralTurn` with `modelSource: "session"`. That combination is what a faithful prediction needs:

- the session's own model, system prompt, tool catalog, thinking level and prompt-cache key as the turn;
- the session history, including the in-flight partial reply;
- no write to the session, so the candidate never appears in the transcript;
- no blocking of a concurrent main turn.

The model choice is deliberately **not** the side channel's. `runEphemeralTurn` defaults to `sideChannelModel`, which `/btw`, `/omfg` and the idle recap use so they can be pointed at a cheaper model. A prediction is not that: it continues the turn the user is looking at, and the provider's cached prefix belongs to the model that produced it. Using the tiny or side-channel model would both miss that cache in full and write the candidate in a different model's voice. Hence the explicit `modelSource: "session"`, which is also why the setting's description promises cache reuse rather than a cheap call.

## 2. Request contract

The instruction lives in `packages/coding-agent/src/prompts/system/suggestion-instruction.md`. It states that the app generated the request, asks for the single message the user is most likely to type, requires the user's own voice and language, and demands exactly one line of plain text — or the literal `null` when the conversation offers no grounded next move. JSON, alternatives and explanations are refused explicitly.

The response is read as plain text: no output schema, no tool use. `promptSuggestionText` trims the edges and treats an empty string or the bare word `null` as "no suggestion"; anything else is preserved verbatim.

## 3. When a suggestion is generated

The policy lives in the bundled Cordis plugin `musepi-prompt-suggestion` (`packages/coding-agent/src/bundled-plugins/prompt-suggestion`), not in the daemon. The plugin subscribes to `agent_end` and checks five gates:

| Gate | Rule |
| --- | --- |
| Host | `ctx.showSuggestion` and `ctx.runEphemeralTurn` must exist; print, RPC and TUI hosts supply neither, so they never spend a request |
| Setting | `suggestion.enabled` (default on), re-read before starting and again before publishing |
| Settlement | `event.willContinue` must be absent — an already-scheduled continuation has not settled |
| Turn outcome | the last assistant message must not carry `stopReason` `aborted` or `error` |
| Concurrency | one request per session; `turn_start`, `input` and `session_shutdown` cancel the in-flight one |

Prediction is best-effort background work: a failed attempt is retried once with the identical request, the whole request is bounded by an 80-second timeout, and nothing reaches the user — no toast, no event, no transcript entry.

Plugins without a composer stay silent because the capability is absent rather than false: the daemon wires `showSuggestion` to the session's subscribers, and every other host omits it.

## 4. Delivery and staleness

A successful prediction reaches `ctx.showSuggestion`, which the daemon wires to `{ kind: "suggestion", payload: { suggestion } }` on the session's subscribers — alongside the existing `title` and `recap` envelopes. It is session state, not a transcript event.

The client keeps one candidate per session in `packages/client-core/src/lib/prompt-suggestion.ts`. Staleness is handled at both ends rather than with turn ids:

- the daemon cancels the in-flight request on `turn_start`, so a prediction cannot survive the turn it describes;
- the composer clears the candidate on send, so an aborted turn cannot resurrect it;
- the store is keyed by session, so switching conversations never carries a candidate across.

## 5. Presentation

Both composers (`apps/desktop/src/components/Composer.tsx` for the desktop shell, `packages/client-core/src/components/shell/Composer.tsx` for the guest/mobile shell) read the same store and follow one contract:

- shown only while the draft is empty, the composer is writable, no ask dialog owns the input, and voice capture is idle;
- rendered as a single ellipsised line in the placeholder slot, aligned to the textarea's own metrics, followed by a `Tab` key cap;
- non-interactive (`pointer-events: none`): a click belongs to the textarea underneath, so the caret is never stolen;
- accepting leaves the candidate in the store — clearing the text brings the same prediction back instead of losing it.

## 6. Configuration

One setting: `suggestion.enabled` (`packages/coding-agent/src/config/settings-schema.ts`), default `true`, surfaced in Settings → 会话与记忆 → 会话 as 候选输入建议. The model is not configurable on purpose — the prediction always uses the session's own model, because any other model invalidates the cached prefix it is built on.
