import { afterAll, describe, expect, it } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { AsyncJobBar } from "../src/components/shell/AsyncJobBar";
import type { JobsRpc } from "../src/lib/async-jobs";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

afterAll(() => {
	GlobalRegistrator.unregister();
});

function rpcWith(running: Array<{ id: string; type: string; status: string; label: string; startTime: number }>) {
	const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
	const rpc: JobsRpc = {
		async request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
			calls.push({ method, params });
			if (method === "session.jobs") return { running, recent: [] } as T;
			if (method === "session.jobOutput") return { output: "line one\nline two" } as T;
			return {} as T;
		},
	};
	return { rpc, calls };
}

describe("AsyncJobBar", () => {
	it("renders the expanded card and chip while a job runs", async () => {
		const { rpc } = rpcWith([
			{ id: "bg1", type: "bash", status: "running", label: "bun test", startTime: Date.now() - 65_000 },
		]);
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		await act(async () => root.render(createElement(AsyncJobBar, { client: rpc, sessionId: "s1" })));
		await act(async () => Bun.sleep(20));

		expect(host.querySelector(".sh-jobcard")).not.toBeNull();
		expect(host.textContent).toContain("Bash 1 running");
		expect(host.textContent).toContain("$ bun test");
		expect(host.querySelector(".sh-jobtime")?.textContent).toContain("1m");
		expect(host.querySelector(".sh-jobs-chip-count")?.textContent).toBe("1");

		await act(async () => root.unmount());
	});

	it("renders nothing when no job runs", async () => {
		const { rpc } = rpcWith([]);
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		await act(async () => root.render(createElement(AsyncJobBar, { client: rpc, sessionId: "s1" })));
		await act(async () => Bun.sleep(20));
		expect(host.textContent).toBe("");
		await act(async () => root.unmount());
	});
});
