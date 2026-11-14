import "./happy-dom-shim";
import { afterAll, afterEach, describe, expect, test, vi } from "bun:test";
import { setLocale } from "@musepi/client-core";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SessionArtifactPreviewDialog } from "../src/components/SessionArtifactPreviewDialog";
import type { RpcClient, StreamEvent } from "../src/lib/rpc";

setLocale("en-US");
afterAll(() => setLocale("zh-CN"));
afterEach(() => vi.restoreAllMocks());

class FakeRpc {
	requests: { method: string; params: unknown }[] = [];
	response: unknown = { text: "raw output", truncated: false, totalBytes: 10 };
	error?: Error;
	deferred?: PromiseWithResolvers<unknown>;

	request<T>(method: string, params?: unknown): Promise<T> {
		this.requests.push({ method, params: params ?? {} });
		if (this.deferred) return this.deferred.promise as Promise<T>;
		return this.error ? Promise.reject(this.error) : Promise.resolve(this.response as T);
	}

	addEventListener(_handler: (event: StreamEvent) => void): () => void {
		return () => {};
	}
}

function mount(fake: FakeRpc, onClose: () => void = () => {}): { root: Root; host: HTMLDivElement } {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	act(() =>
		root.render(
			createElement(SessionArtifactPreviewDialog, {
				rpc: fake as unknown as RpcClient,
				request: { sessionId: "s1", id: "42" },
				onClose,
			}),
		),
	);
	return { root, host };
}

describe("SessionArtifactPreviewDialog", () => {
	test("loads the raw artifact in its owning session and closes from the visible action", async () => {
		const fake = new FakeRpc();
		const closed: string[] = [];
		const { root, host } = mount(fake, () => closed.push("close"));
		await act(async () => Bun.sleep(0));
		expect(fake.requests).toEqual([{ method: "session.artifactRead", params: { sessionId: "s1", id: "42" } }]);
		expect(document.body.textContent).toContain("raw output");
		const close = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button =>
			button.textContent?.includes("Close"),
		);
		expect(close).toBeDefined();
		act(() => close!.click());
		expect(closed).toEqual(["close"]);
		act(() => root.unmount());
		host.remove();
	});

	test("labels a bounded preview and surfaces read errors", async () => {
		const fake = new FakeRpc();
		fake.response = { text: "prefix", truncated: true, totalBytes: 9000 };
		const { root, host } = mount(fake);
		await act(async () => Bun.sleep(0));
		expect(document.body.textContent).toContain("truncated");
		expect(document.body.textContent).toContain("8.8KB");
		fake.error = new Error("Artifact missing");
		act(() =>
			root.render(
				createElement(SessionArtifactPreviewDialog, {
					rpc: fake as unknown as RpcClient,
					request: { sessionId: "s1", id: "42" },
					onClose: () => {},
				}),
			),
		);
		await act(async () => Bun.sleep(0));
		expect(document.body.textContent).toContain("Artifact missing");
		act(() => root.unmount());
		host.remove();
	});

	test("ignores the response when unmounted before the read settles", async () => {
		const fake = new FakeRpc();
		fake.deferred = Promise.withResolvers<unknown>();
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const { root, host } = mount(fake);
		act(() => root.unmount());
		fake.deferred.resolve({ text: "late", truncated: false, totalBytes: 4 });
		await act(async () => Bun.sleep(0));
		expect(errors).not.toHaveBeenCalled();
		host.remove();
	});
});
