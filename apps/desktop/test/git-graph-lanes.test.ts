import { describe, expect, it } from "bun:test";
import { solveGraphLanes } from "../src/lib/git-graph-lanes";

/** Git-panel graph rail contract: the lane solver must keep linear history
 *  in one column, open/merge lanes for branches, converge stale columns
 *  into the node they were waiting for, and stay stable when load-more
 *  re-solves the accumulated list. */
describe("solveGraphLanes", () => {
	it("linear history stays in lane 0 with straight pass segments", () => {
		const layout = solveGraphLanes([
			{ hash: "a", parents: ["b"] },
			{ hash: "b", parents: ["c"] },
			{ hash: "c", parents: [] },
		]);
		expect(layout.lanes).toBe(1);
		expect(layout.rows.map(r => r.lane)).toEqual([0, 0, 0]);
		for (const row of layout.rows) {
			expect(row.segments.every(s => s.kind === "pass" && s.from === 0 && s.to === 0)).toBe(true);
		}
	});

	it("merge forks a feature lane out and the feature line joins back into the base", () => {
		// m = merge(a, f); a/f both descend from b; c is the root.
		const layout = solveGraphLanes([
			{ hash: "m", parents: ["a", "f"] },
			{ hash: "a", parents: ["b"] },
			{ hash: "f", parents: ["b"] },
			{ hash: "b", parents: ["c"] },
			{ hash: "c", parents: [] },
		]);
		expect(layout.lanes).toBe(2);
		// Merge commit forks its second parent out to a new lane.
		const mergeRow = layout.rows[0]!;
		expect(mergeRow.lane).toBe(0);
		expect(mergeRow.segments).toContainEqual({ from: 0, to: 1, kind: "merge" });
		// Feature tip sits on its own lane…
		expect(layout.rows[2]!.lane).toBe(1);
		// …and the base commit consumes both waiting columns via a join.
		const baseRow = layout.rows[3]!;
		expect(baseRow.lane).toBe(0);
		expect(baseRow.segments).toContainEqual({ from: 1, to: 0, kind: "join" });
	});

	it("two children of the same root converge with a join into it", () => {
		const layout = solveGraphLanes([
			{ hash: "x", parents: ["r"] },
			{ hash: "y", parents: ["r"] },
			{ hash: "r", parents: [] },
		]);
		expect(layout.lanes).toBe(2);
		const rootRow = layout.rows[2]!;
		expect(rootRow.lane).toBe(0);
		expect(rootRow.segments).toContainEqual({ from: 1, to: 0, kind: "join" });
	});

	it("load-more re-solve keeps already-seen rows stable", () => {
		const page1 = [
			{ hash: "a", parents: ["b"] },
			{ hash: "b", parents: ["c"] },
		];
		const full = [...page1, { hash: "c", parents: [] }];
		const before = solveGraphLanes(page1);
		const after = solveGraphLanes(full);
		expect(after.rows.slice(0, page1.length)).toEqual(before.rows);
		expect(after.lanes).toBe(before.lanes);
	});

	it("self-referential parent is dropped instead of looping the lane", () => {
		const layout = solveGraphLanes([{ hash: "a", parents: ["a"] }]);
		expect(layout.lanes).toBe(1);
		expect(layout.rows[0]!.lane).toBe(0);
		expect(layout.rows[0]!.segments).toEqual([]);
	});
});
