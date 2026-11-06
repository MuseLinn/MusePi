import { describe, expect, it } from "bun:test";
import { requestAgentDetach, setAgentDetachHandle } from "./detach-registry";

const NOT_RUNNING = { ok: false, error: "agent is not running in the foreground" };

describe("agent detach registry", () => {
	it("reports an unknown agent without throwing", async () => {
		expect(await requestAgentDetach("DetachMissing")).toEqual(NOT_RUNNING);
	});

	it("routes one request to the registered handle, then consumes it", async () => {
		let calls = 0;
		const unregister = setAgentDetachHandle("DetachOnce", async () => {
			calls += 1;
			return { ok: true, jobId: "job-1" };
		});
		try {
			expect(await requestAgentDetach("DetachOnce")).toEqual({ ok: true, jobId: "job-1" });
			// A detach is a one-shot intent: a second click must not adopt the
			// same run into a second job.
			expect(await requestAgentDetach("DetachOnce")).toEqual(NOT_RUNNING);
			expect(calls).toBe(1);
		} finally {
			unregister();
		}
	});

	it("keeps the latest registration and ignores stale unregisters", async () => {
		const unregisterFirst = setAgentDetachHandle("DetachLatest", async () => ({ ok: true, jobId: "old" }));
		const unregisterSecond = setAgentDetachHandle("DetachLatest", async () => ({ ok: true, jobId: "new" }));
		try {
			// The first run settling late must not remove its successor's handle.
			unregisterFirst();
			expect(await requestAgentDetach("DetachLatest")).toEqual({ ok: true, jobId: "new" });
		} finally {
			unregisterSecond();
		}
	});

	it("stops routing after the registering run unregisters", async () => {
		const unregister = setAgentDetachHandle("DetachGone", async () => ({ ok: true, jobId: "job" }));
		unregister();
		expect(await requestAgentDetach("DetachGone")).toEqual(NOT_RUNNING);
	});

	it("turns a throwing handle into a failed result", async () => {
		const unregister = setAgentDetachHandle("DetachThrow", () => {
			throw new Error("adoption exploded");
		});
		try {
			expect(await requestAgentDetach("DetachThrow")).toEqual({ ok: false, error: "adoption exploded" });
		} finally {
			unregister();
		}
	});
});
