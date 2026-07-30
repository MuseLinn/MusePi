Searches the web for up-to-date information beyond knowledge cutoff.

<instruction>
- You SHOULD prefer primary sources (papers, official docs) and corroborate key claims with multiple sources
- You MUST include links for cited sources in the final response
- NEVER use for content that is programmatically accessible or whose URL you already know (GitHub repos/issues, a known arXiv paper, a Wikipedia page, official docs) — `read` the URL directly instead
- `query` supports Google-style directives on every provider: `site:`/`-site:`, `after:`/`before:` (`YYYY-MM-DD`), `inurl:`, `intitle:`, `filetype:`, `"exact phrase"`, `-term`, `OR`. Constraints map to native provider filters where available; otherwise results are filtered leniently — a constraint matching nothing is relaxed and reported instead of returning zero results.
</instruction>
