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

function rpcWith(
	running: Array<{ id: string; type: string; status: string; label: string; startTime: number }>,
	recent: Array<{ id: string; type: string; status: string; label: string; startTime: number }> = [],
) {
	const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
	const rpc: JobsRpc = {
		async request<T>(method: string, params?: Record<string, unknown>): Promise<T> {
			calls.push({ method, params });
			if (method === "session.jobs") return { running, recent } as T;
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
		expect(host.textContent).toContain("Command 1 running");
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

	it("lists finished tasks with their status on demand", async () => {
		const { rpc } = rpcWith(
			[{ id: "bg1", type: "bash", status: "running", label: "bun test", startTime: Date.now() }],
			[
				{ id: "bg0", type: "task", status: "completed", label: "review the diff", startTime: Date.now() - 9_000 },
				{ id: "bg9", type: "bash", status: "failed", label: "bun check", startTime: Date.now() - 8_000 },
			],
		);
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		await act(async () => root.render(createElement(AsyncJobBar, { client: rpc, sessionId: "s1" })));
		await act(async () => Bun.sleep(20));

		const toggle = host.querySelector(".sh-jobcard-all");
		expect(toggle?.textContent).toContain("All tasks");
		await act(async () => {
			toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});

		expect(host.textContent).toContain("review the diff");
		expect(host.textContent).toContain("Completed");
		expect(host.textContent).toContain("Failed");
		await act(async () => root.unmount());
	});

	it("names job types and statuses in the active locale", async () => {
		const { setLocale } = await import("../src/i18n");
		setLocale("zh-CN");
		try {
			const { rpc } = rpcWith([
				{ id: "bg1", type: "task", status: "running", label: "review", startTime: Date.now() },
			]);
			const host = document.createElement("div");
			document.body.appendChild(host);
			const root = createRoot(host);
			await act(async () => root.render(createElement(AsyncJobBar, { client: rpc, sessionId: "s1" })));
			await act(async () => Bun.sleep(20));

			expect(host.textContent).toContain("子代理 1 运行中");
			expect(host.textContent).toContain("后台 子代理");
			await act(async () => root.unmount());
		} finally {
			setLocale("en-US");
		}
	});
});
