import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * The virtualizer's measurement contract, held as a source invariant.
 *
 * `measureElement` silently ignores a row whose `data-index` is missing or
 * whose recorded index no longer matches its position: it leaves that row's
 * height at the estimate. A row that starts estimating and stops measuring
 * renders, but the transcript is laid out against a guess.
 */
const TRANSCRIPT = new URL("../../../packages/client-core/src/components/transcript/Transcript.tsx", import.meta.url);
const source = readFileSync(TRANSCRIPT, "utf8");

describe("transcript virtual rows", () => {
	test("every measured row carries data-index and the measure ref", () => {
		// The virtualized branch is the only one that measures; the full-list
		// fallback (no scroller: happy-dom, SSR) deliberately has neither.
		const measured = source.match(/ref=\{measureVirtualRow\}/g) ?? [];
		const indexes = source.match(/data-index=\{vi\.index\}/g) ?? [];
		expect(measured.length).toBe(1);
		expect(indexes.length).toBe(measured.length);
	});

	test("the row key is the view key, and no other entry id reaches the DOM", () => {
		// A stray `data-entry-id` on the row would tempt selectors back to the
		// ack-swapped entry id; the flight targets `data-entry-key`.
		const rowTags = source.match(/<div\s+key=\{row\.key\}[\s\S]{0,900}?className="tr-vrow"/g) ?? [];
		expect(rowTags.length).toBeGreaterThan(0);
		for (const tag of rowTags) {
			expect(tag).toContain("data-entry-key={row.key}");
			expect(tag).not.toContain("data-entry-id");
		}
	});
});
