{{#if contextFiles.length}}
<repo-rules>
MUST follow these context files for all tasks:
{{#each contextFiles}}
<file path="{{path}}">
{{content}}
</file>
{{/each}}
</repo-rules>
{{/if}}

{{#if agentsMdSearch.files.length}}
<dir-context>
Some directories may have rules; deeper rules override higher ones.
Before changes in these directories, MUST read:
{{#list agentsMdSearch.files join="\n"}}- {{this}}{{/list}}
</dir-context>
{{/if}}

{{#ifAny contextFiles.length agentsMdSearch.files.length}}
Context files above auto-loaded. NEVER `grep`/`glob` for `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, or similar agent/context files: relevant files already in context; others noise.
{{/ifAny}}

{{#if includeWorkspaceTree}}
{{#if workspaceTree.rendered}}
<workspace-tree>
Working-directory layout: newest mtime first; depth ≤ 3.
{{workspaceTree.rendered}}
{{#if workspaceTree.truncated}}
{{#has tools "glob"}}{{#has tools "read"}}Some entries elided to shorten tree — use `{{toolRefs.glob}}`/`{{toolRefs.read}}` to drill in.{{/has}}{{/has}}
{{/if}}
</workspace-tree>
{{/if}}
{{/if}}
