{{#if contextFiles.length}}
<project-context>
Context files: user's standing project instructions (AGENTS.md etc.); binding on driving agent. Enforce; flag drift immediately; NEVER advise against mandates.
{{#each contextFiles}}
<file path="{{path}}">
{{content}}
</file>
{{/each}}
</project-context>
{{/if}}
{{#if additionalWorkspaceRoots.length}}
<workspace-roots>
Related project directories: user-added additional roots of THIS workspace, as much part of the project as the working directory. Files there are real; NEVER report them as missing or absent from the repository. Relative paths resolve against the working directory, so address these roots with absolute paths when reading or searching.
{{#each additionalWorkspaceRoots}}
- {{this}}
{{/each}}
</workspace-roots>
{{/if}}