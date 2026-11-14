import { describe, expect, test } from "bun:test";
import { emitCapabilityNavAction, subscribeCapabilityNavAction } from "../src/lib/capability-nav";
import { emitTaskNavAction, subscribeTaskNavAction } from "../src/lib/scheduled-task-nav";

/**
 * Hover-peek commits a destination whose page is not mounted yet: the row's
 * click is emitted during the rail's 150ms swap, so the action has to survive
 * until the page subscribes. These pin that one-shot replay — and that a live
 * dispatch never lingers into the next visit.
 */

describe("task-center nav actions across a destination swap", () => {
	test("replays the pre-mount selection exactly once", () => {
		const seen: unknown[] = [];
		emitTaskNavAction({ type: "select", id: "task-7" });

		const first = subscribeTaskNavAction(action => seen.push(action));
		expect(seen).toEqual([{ type: "select", id: "task-7" }]);
		first();

		const replayOnRemount: unknown[] = [];
		const second = subscribeTaskNavAction(action => replayOnRemount.push(action));
		expect(replayOnRemount).toEqual([]);
		second();
	});

	test("a mounted page receives actions directly and retains nothing", () => {
		const seen: unknown[] = [];
		const unsubscribe = subscribeTaskNavAction(action => seen.push(action));
		emitTaskNavAction({ type: "view", view: "runs" });
		expect(seen).toEqual([{ type: "view", view: "runs" }]);
		unsubscribe();

		const after = subscribeTaskNavAction(() => {});
		expect(after).toBeFunction();
		after();
	});
});

describe("capability-center nav actions across a destination swap", () => {
	test("replays the pre-mount tab selection exactly once", () => {
		const seen: unknown[] = [];
		emitCapabilityNavAction({ type: "select", tab: "plugins" });

		const first = subscribeCapabilityNavAction(action => seen.push(action));
		expect(seen).toEqual([{ type: "select", tab: "plugins" }]);
		first();

		const replayOnRemount: unknown[] = [];
		const second = subscribeCapabilityNavAction(action => replayOnRemount.push(action));
		expect(replayOnRemount).toEqual([]);
		second();
	});

	test("a mounted page receives actions directly and retains nothing", () => {
		const seen: unknown[] = [];
		const unsubscribe = subscribeCapabilityNavAction(action => seen.push(action));
		emitCapabilityNavAction({ type: "add" });
		expect(seen).toEqual([{ type: "add" }]);
		unsubscribe();

		const after = subscribeCapabilityNavAction(() => {});
		expect(after).toBeFunction();
		after();
	});
});
