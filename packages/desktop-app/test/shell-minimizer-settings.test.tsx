import "./happy-dom-shim";
import { afterAll, afterEach, describe, expect, test, vi } from "bun:test";
import { setLocale } from "@musepi/client-core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { hasUi, SETTINGS_SCHEMA } from "../../coding-agent/src/config/settings-schema";
import { ShellSection } from "../src/components/settings-sections/shell";
import type { RpcClient, StreamEvent } from "../src/lib/rpc";

setLocale("zh-CN");
afterAll(() => setLocale("en-US"));
afterEach(() => vi.restoreAllMocks());

class FakeRpc {
	responses = new Map<string, unknown>();
	requests: { method: string; params: unknown }[] = [];
	deferred?: PromiseWithResolvers<unknown>;

	request<T>(method: string, params?: unknown): Promise<T> {
		this.requests.push({ method, params: params ?? {} });
		if (method === "settings.shellMinimizerStats" && this.deferred) return this.deferred.promise as Promise<T>;
		return Promise.resolve(this.responses.get(method) as T);
	}

	addEventListener(_handler: (event: StreamEvent) => void): () => void {
		return () => {};
	}

	calls(method: string): unknown[] {
		return this.requests.filter(r => r.method === method).map(r => r.params);
	}
}

const asRpc = (fake: FakeRpc): RpcClient => fake as unknown as RpcClient;
const stats = {
	totalCommands: 2,
	totalInputBytes: 3000,
	totalOutputBytes: 1250,
	totalSavedBytes: 1750,
	savingsPct: (1750 / 3000) * 100,
	byFilter: [
		{ filter: "cargo", commands: 1, inputBytes: 2000, outputBytes: 1000, savedBytes: 1000 },
		{ filter: "git", commands: 1, inputBytes: 1000, outputBytes: 250, savedBytes: 750 },
	],
};

const shellSchema = Object.entries(SETTINGS_SCHEMA).flatMap(([key, def]) =>
	def.ui?.tab === "shell" ? [{ key, type: def.type, default: def.default, ui: def.ui }] : [],
);

function fakeWithStats(): FakeRpc {
	const fake = new FakeRpc();
	fake.responses.set("settings.schema", { shell: shellSchema });
	fake.responses.set("settings.get", {});
	fake.responses.set("settings.shellMinimizerStats", stats);
	return fake;
}

function mount(fake: FakeRpc): { host: HTMLDivElement; root: Root } {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	act(() => root.render(createElement(ShellSection, { rpc: asRpc(fake) })));
	return { host, root };
}

describe("Shell minimizer settings", () => {
	test("renders aggregate savings and refreshes them through the daemon", async () => {
		const fake = fakeWithStats();
		const { host, root } = mount(fake);
		await act(async () => Bun.sleep(0));

		expect(host.textContent).toContain("1.7KB");
		expect(host.textContent).toContain("58.3%");
		expect(host.textContent).toContain("cargo");
		const progress = host.querySelector("progress");
		expect(progress?.getAttribute("max")).toBe("100");
		expect(progress?.getAttribute("value")).toBe(String(stats.savingsPct));
		expect(progress?.getAttribute("aria-label")).toBe("Shell 精简率");

		const refresh = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button =>
			button.textContent?.includes("刷新"),
		);
		expect(refresh).toBeDefined();
		act(() => refresh!.click());
		await act(async () => Bun.sleep(0));
		expect(fake.calls("settings.shellMinimizerStats")).toHaveLength(2);
		act(() => root.unmount());
		host.remove();
	});

	test("requests every advanced minimizer setting through the shared schema", async () => {
		const fake = fakeWithStats();
		const { host, root } = mount(fake);
		await act(async () => Bun.sleep(0));
		const keys = fake.calls("settings.get")[0] as { keys: string[] };
		for (const key of [
			"shellMinimizer.settingsPath",
			"shellMinimizer.only",
			"shellMinimizer.except",
			"shellMinimizer.maxCaptureBytes",
			"shellMinimizer.legacyFilters",
		]) {
			expect(hasUi(key as Parameters<typeof hasUi>[0])).toBe(true);
			expect(key.startsWith("shellMinimizer.")).toBe(true);
		}
		expect(keys.keys).toContain("shellMinimizer.settingsPath");
		act(() => root.unmount());
		host.remove();
	});

	test("ignores a stats response that arrives after unmount", async () => {
		const fake = fakeWithStats();
		fake.deferred = Promise.withResolvers<unknown>();
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const { host, root } = mount(fake);
		act(() => root.unmount());
		fake.deferred.resolve(stats);
		await act(async () => Bun.sleep(0));
		expect(errors).not.toHaveBeenCalled();
		host.remove();
	});
});
