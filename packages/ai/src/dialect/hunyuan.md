## Format guide

Emit every call of a turn inside one `<tool_calls:ID>` envelope. `ID` is any short lowercase hex string — reuse the SAME id for every call in the envelope and for the closing tag:

```text
<tool_calls:ID>
<tool_call:ID>NAME
 OPTIONS={"arg":"value"}
</tool_calls:ID>
```

Tool results arrive later as plain text lines, one per call, in call order:

```text
TOOL_RESULT[ID] NAME
verbatim tool result
```

## Rules

- `NAME` MUST match a listed function exactly, and MUST sit on the same line as its `<tool_call:ID>` opening tag.
- `OPTIONS=` MUST start the line after the name, and MUST be one JSON object with double-quoted keys.
- Argument string values use only normal JSON strings — never HTML-escape them: write `a & b`, not `a &amp; b`.
- Multiple calls = several `<tool_call:ID>NAME` + `OPTIONS={…}` pairs inside ONE `<tool_calls:ID>` envelope, all sharing that envelope's id.
- Private reasoning, when supported, goes in `<think>…</think>` before the envelope; NEVER put tool calls inside `<think>`.
- Read each result line in call order. NEVER emit result lines yourself.
- Emit the closing `</tool_calls:ID>` ONLY after the last call is fully written — NEVER announce a tool then stop (e.g. halting at "let me read that file" with no `<tool_call:…>` emitted). Write the complete envelope, THEN halt.
