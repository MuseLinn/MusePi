/**
 * Regression guard: side-by-side diff rows must NOT nest tv-diff-sbs-cell
 * (the old cell() returned a cell-classed span inside the outer cell —
 * padding 9px applied twice → line-number gutters misaligned between rows).
 * Every row: one outer .tv-diff-sbs-cell wrapping the line number + content.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DiffBlock } from "../src/tool-render/parts";

const DIFF = `--- a/server.ts
+++ b/server.ts
@@ -373,3 +373,4 @@
 import { ModelsConfigFile } from "../config/models-config";
 import type { ExtensionSetting, ExtensionUIContext } from "../extensibility/extensions/types";
+import type { ExtensionAskDialogResult } from "../extensibility/extensions/types";
 import type { AgentSession } from "../session/agent-session";
 import type { StoredAuthCredential } from "../session/auth-storage";
`;

describe("DiffBlock side-by-side structure", () => {
	test("no nested tv-diff-sbs-cell; every row has exactly one outer cell", () => {
		const html = renderToStaticMarkup(<DiffBlock diff={DIFF} layout="side-by-side" />);
		// Count outer cells: rows are `tv-diff-sbs-row` with exactly 1 or 2 cells.
		const rows = html.split('<div class="tv-diff-sbs-row');
		expect(rows.length).toBeGreaterThan(3);
		for (const row of rows.slice(1)) {
			// Count cell ELEMENTS via the class attribute (the --add/--del
			// modifier classes contain the substring "tv-diff-sbs-cell").
			const cellCount = (row.match(/class="tv-diff-sbs-cell/g) ?? []).length;
			const lnCount = (row.match(/tv-diff-ln/g) ?? []).length;
			// ctx rows: 2 cells + 2 lns; add/del rows: 2 cells (the empty
			// pane still carries a cell), 2 lns; hunk/header rows: 1 cell.
			if (row.includes("--hunk") || row.includes("--header") || row.includes("--gap")) {
				expect(cellCount).toBe(1);
			} else {
				expect(cellCount).toBe(2);
				expect(lnCount).toBe(2);
			}
			// The critical invariant: NO cell contains a nested cell (the old
			// nesting produced cell > ln > cell).
			expect(row).not.toMatch(
				/class="tv-diff-sbs-cell[^"]*"><span class="tv-diff-ln"[^>]*><span class="tv-diff-sbs-cell/,
			);
		}
	});

	test("cell content sits directly inside the outer cell (no wrapper class)", () => {
		const html = renderToStaticMarkup(<DiffBlock diff={DIFF} layout="side-by-side" />);
		// An add row renders as: cell--add > ln + raw text (no nested cell span).
		const addRow = html.match(/tv-diff-sbs-row tv-diff-sbs-row--add">.*?<\/div>/s)?.[0];
		expect(addRow).toBeDefined();
		// The old bug produced cell > ln > cell; the fix renders cell > ln + text.
		expect(addRow!).not.toMatch(/class="tv-diff-sbs-cell[^"]*"><span class="tv-diff-ln"[^>]*><span class="tv-diff-sbs-cell/);
		expect(addRow!).toContain('class="tv-diff-ln">375</span>+import type { ExtensionAskDialogResult }');
	});
});
