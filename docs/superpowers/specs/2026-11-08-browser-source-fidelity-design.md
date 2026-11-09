# Browser source-card fidelity design

## Intent

Make the existing turn Sources card truthful for both legacy browser runs and the new structured actions. Read pages and pages merely passed through must come from actual tool evidence, with no duplicate card or second data pipeline.

## Goals

- A successful structured `read` marks its `pageText.url` as read and uses its page title.
- A successful `open` or completed `goto` counts as a visit. Repeated visits increment `opens`; the first read/observation of an already-open page still has `opens: 1`.
- A page is created only by open/navigation or a successful content observation/read. Screenshots, clicks, status calls, and other operations may enrich an existing page but cannot create a passed-through page by themselves.
- Preserve first-seen order, read/passed grouping, existing capabilities, and legacy `observe` behavior.

## Non-goals

- No new Sources card, renderer state store, Agent tool action, or claim of complete Kimi protocol parity in this change.
- No counting of failed/running calls, screenshots, or status queries as reads or visits.

## Approaches

1. **Repair the existing aggregation (selected).** Extend `collectTurnSources` to consume `action`, `pageText`, `url`, and operations from the same tool details already in the transcript. This covers structured and historical results with no new runtime channel.
2. **Aggregate inside each browser card.** Rejected: it cannot produce one deduplicated turn-level source list and would repeat UI.
3. **Add a daemon source ledger.** Rejected: the persisted tool results already carry the authoritative evidence.

## Verification

Add contract tests proving structured reads, open visits, deduplication, legacy observations, and rejection of screenshot/click-only page fabrication. Run turn-surface and source-card tests, client-core checks, generated tool views, and the full related browser suite.
