import "./happy-dom-shim";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { setLocale } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JOB_OUTPUT_TAIL_LIMIT, JobsPane, mergeJobOutput } from "../src/components/ContextPanel";
import type { RpcClient } from "../src/lib/rpc";

// 任务面板契约:列表每秒刷新一次(面板可见时才挂载),「运行中/全部」筛选默认运行中,
// 选中任务后输出尾部实时累积,后台提问任务显示问题数与等待回答状态,取消仍然可用。

interface RequestRecord {
	method: string;
	params: Record<string, unknown>;
}

interface JobsResponse {
	running: Array<Record<string, unknown>>;
	recent: Array<Record<string, unknown>>;
	delivery?: { queued: number; delivering: boolean; pendingJobIds: string[] };
}

const EMPTY_DELIVERY = { queued: 0, delivering: false, pendingJobIds: [] };

function fakeRpc(respond: (method: string, params: Record<string, unknown>) => unknown): {
	rpc: RpcClient;
	calls: RequestRecord[];
} {
	const calls: RequestRecord[] = [];
	const rpc = {
		request: async (method: string, params: Record<string, unknown>) => {
			calls.push({ method, params });
			return respond(method, params);
		},
		addEventListener: () => () => {},
	} as unknown as RpcClient;
	return { rpc, calls };
}

const roots: Root[] = [];
const hosts: HTMLElement[] = [];

async function mount(rpc: RpcClient, visible = true): Promise<HTMLElement> {
	const host = document.createElement("div");
	document.body.appendChild(host);
	hosts.push(host);
	const root = createRoot(host);
	roots.push(root);
	await act(async () => {
		root.render(<JobsPane rpc={rpc} sessionId="s1" visible={visible} />);
	});
	return host;
}

function jobCalls(calls: RequestRecord[], method: string): RequestRecord[] {
	return calls.filter(call => call.method === method);
}

beforeEach(() => {
	setLocale("en-US");
	vi.useFakeTimers();
});

afterEach(async () => {
	while (roots.length > 0) {
		const root = roots.pop()!;
		await act(async () => {
			root.unmount();
		});
	}
	while (hosts.length > 0) hosts.pop()!.remove();
	vi.useRealTimers();
});

describe("JobsPane 轮询与筛选", () => {
	it("每秒刷新任务列表,而不是每 5 秒", async () => {
		const { rpc, calls } = fakeRpc(() => ({ running: [], recent: [], delivery: EMPTY_DELIVERY }));
		await mount(rpc);
		expect(jobCalls(calls, "session.jobs")).toHaveLength(1);

		await act(async () => {
			vi.advanceTimersByTime(999);
		});
		expect(jobCalls(calls, "session.jobs")).toHaveLength(1);

		await act(async () => {
			vi.advanceTimersByTime(1);
		});
		expect(jobCalls(calls, "session.jobs")).toHaveLength(2);
	});

	it("面板收起时不轮询,展开后才开始", async () => {
		const { rpc, calls } = fakeRpc(() => ({ running: [], recent: [], delivery: EMPTY_DELIVERY }));
		const host = await mount(rpc, false);
		await act(async () => {
			vi.advanceTimersByTime(5000);
		});
		// Closed panel: body stays mounted but must not spend a poll per second.
		expect(jobCalls(calls, "session.jobs")).toHaveLength(0);

		const root = roots[roots.length - 1]!;
		await act(async () => {
			root.render(<JobsPane rpc={rpc} sessionId="s1" visible />);
		});
		expect(jobCalls(calls, "session.jobs")).toHaveLength(1);
		await act(async () => {
			vi.advanceTimersByTime(1000);
		});
		expect(jobCalls(calls, "session.jobs")).toHaveLength(2);
		expect(host.textContent).toContain("Running");
	});

	it("默认只显示运行中,切到全部才显示最近任务", async () => {
		const data: JobsResponse = {
			running: [{ id: "live", type: "bash", status: "running", label: "dev server", startTime: 1 }],
			recent: [{ id: "done", type: "bash", status: "completed", label: "old build", startTime: 2 }],
			delivery: EMPTY_DELIVERY,
		};
		const { rpc } = fakeRpc(() => data);
		const host = await mount(rpc);
		expect(host.textContent).toContain("dev server");
		expect(host.textContent).not.toContain("old build");

		const segments = [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
		expect(segments).toHaveLength(2);
		await act(async () => {
			segments[1]!.click();
		});
		expect(host.textContent).toContain("dev server");
		expect(host.textContent).toContain("old build");
	});

	it("后台提问任务显示问题数与等待回答状态", async () => {
		const data: JobsResponse = {
			running: [
				{
					id: "q1",
					type: "question",
					status: "running",
					label: "Ask: Which database? (+1 more)",
					startTime: 3,
					questionCount: 2,
				},
			],
			recent: [],
			delivery: EMPTY_DELIVERY,
		};
		const { rpc } = fakeRpc(() => data);
		const host = await mount(rpc);
		expect(host.textContent).toContain("2 question(s)");
		expect(host.textContent).toContain("Awaiting answer");
	});
});

describe("JobsPane 输出尾部", () => {
	it("选中任务后拉取输出并实时累积,重复前缀只保留一份", async () => {
		const outputs = ["$ dev server\nready\n", "$ dev server\nready\nlistening on :3000\n"];
		let reads = 0;
		const data: JobsResponse = {
			running: [{ id: "live", type: "bash", status: "running", label: "dev server", startTime: 1 }],
			recent: [],
			delivery: EMPTY_DELIVERY,
		};
		const { rpc, calls } = fakeRpc(method => {
			if (method === "session.jobOutput") {
				const output = outputs[Math.min(reads, outputs.length - 1)]!;
				reads += 1;
				return { output, truncated: false };
			}
			return data;
		});
		const host = await mount(rpc);

		const row = host.querySelector<HTMLButtonElement>('button[aria-pressed="false"]');
		expect(row).not.toBeNull();
		await act(async () => {
			row!.click();
		});
		const outputText = (): string => host.querySelector("pre")?.textContent ?? "";
		expect(outputText()).toBe(outputs[0]);
		expect(jobCalls(calls, "session.jobOutput")[0]?.params).toMatchObject({ sessionId: "s1", jobId: "live" });

		await act(async () => {
			vi.advanceTimersByTime(1000);
		});
		expect(jobCalls(calls, "session.jobOutput")).toHaveLength(2);
		// 第二次读到更长的尾巴:前缀只出现一次,不是拼接出来的两份。
		expect(outputText()).toBe(outputs[1]);
		expect(outputText().match(/ready/g)).toHaveLength(1);
	});

	it("取消仍然可用,并立即重新拉取列表", async () => {
		const data: JobsResponse = {
			running: [{ id: "live", type: "bash", status: "running", label: "dev server", startTime: 1 }],
			recent: [],
			delivery: EMPTY_DELIVERY,
		};
		const { rpc, calls } = fakeRpc(() => data);
		const host = await mount(rpc);
		const cancel = [...host.querySelectorAll("button")].find(button =>
			button.getAttribute("aria-label")?.startsWith("Cancel:"),
		);
		expect(cancel).not.toBeUndefined();
		const before = jobCalls(calls, "session.jobs").length;
		await act(async () => {
			cancel!.click();
		});
		const cancelled = jobCalls(calls, "session.jobsCancel");
		expect(cancelled).toHaveLength(1);
		expect(cancelled[0]?.params).toMatchObject({ sessionId: "s1", jobId: "live" });
		expect(jobCalls(calls, "session.jobs").length).toBeGreaterThan(before);
	});
});

describe("mergeJobOutput", () => {
	it("追加增长时保留整段,而不是重复前缀", () => {
		expect(mergeJobOutput("", "a\n")).toBe("a\n");
		expect(mergeJobOutput("a\n", "a\nb\n")).toBe("a\nb\n");
	});

	it("滑动窗口按最长重叠拼接", () => {
		expect(mergeJobOutput("0123456789", "456789ABCD", 10)).toBe("456789ABCD");
	});

	it("完全被新窗口取代时使用新尾巴", () => {
		expect(mergeJobOutput("xxxx", "yyyy", 10)).toBe("yyyy");
	});

	it("更旧的短尾巴不覆盖已有内容", () => {
		expect(mergeJobOutput("abcdef", "abc", 10)).toBe("abcdef");
	});

	it("超过上限时只保留最近的字符", () => {
		const merged = mergeJobOutput("", "0123456789abc", 10);
		expect(merged).toBe("3456789abc");
		expect(mergeJobOutput("", "x".repeat(JOB_OUTPUT_TAIL_LIMIT + 10)).length).toBe(JOB_OUTPUT_TAIL_LIMIT);
	});
});
