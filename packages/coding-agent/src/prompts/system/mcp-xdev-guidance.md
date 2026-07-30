## MCP Tool Routes

{{#if tools.length}}
Execute each mounted tool by writing JSON arguments to its mounted path:
{{#each tools}}
- {{mcpToolName}} → `{{path}}`
{{/each}}
{{/if}}
{{#if hasOmittedTools}}
Additional mounted MCP tool mappings were omitted to keep this prompt bounded. Inspect `xd://` for the exact current paths.
{{/if}}
