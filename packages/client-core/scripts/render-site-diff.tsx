/**
 * Render the real client-core `DiffBlock` into the marketing site's demo.
 *
 * Build-time island: the site reuses the actual tool-render component without
 * shipping React. Regenerate after changing the diff sample or the component:
 *
 *   bun packages/client-core/scripts/render-site-diff.tsx
 *
 * The script replaces the content between the `demo-diff:start` / `demo-diff:end`
 * markers in web/index.html. Keep the subset of tool-render.css in web/demo.css
 * in sync when the component's markup classes change.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { DiffBlock } from "../src/tool-render/parts";

const DIFF = `--- a/src/panel.tsx
+++ b/src/panel.tsx
@@ -1,4 +1,5 @@
- if (user.role === "admin") {
+ if (isOwner(user) || user.role === "admin") {
+   audit("panel.open", user.id);
    return <Panel />;
  }`;

const START = "<!-- demo-diff:start -->";
const END = "<!-- demo-diff:end -->";
const indexPath = resolve(import.meta.dir, "../../../web/index.html");
const html = readFileSync(indexPath, "utf8");
const start = html.indexOf(START);
const end = html.indexOf(END);
if (start < 0 || end < start) throw new Error("demo-diff markers not found in web/index.html");

const markup = renderToStaticMarkup(<DiffBlock diff={DIFF} layout="inline" />);
const next = `${html.slice(0, start + START.length)}\n${markup}\n${html.slice(end)}`;
writeFileSync(indexPath, next);
console.log(`rendered DiffBlock (${markup.length} bytes) into web/index.html`);
