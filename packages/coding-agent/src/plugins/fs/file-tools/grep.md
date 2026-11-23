- Regex search/target location → `{{grep}}`, not shell `grep`, `rg`, `awk`.
# Data Sources
Text-retrieve BEFORE semantic query. For `.ttl`/`.owl`/`.rq`/`.json`/`.csv`/`.xml`/logs/schemas, `{{grep}}` the file for the identifier or literal you need, THEN parse or query it.
- A parser/query that returns `None`/empty is NOT evidence the field is missing — search the raw file for the entity and check for a different encoding (WKT, alias, nested key) before concluding.
- Specialized query engines (SPARQL, pandas, an in-memory graph) see only what the library exposes; a fact stated as plain text in the source is invisible to them.
