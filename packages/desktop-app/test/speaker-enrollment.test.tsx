import "./happy-dom-shim";
import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SpeakerEnrollment } from "../src/components/composer/speaker-enrollment";
import type { RpcClient } from "../src/lib/rpc";

class FakeRpc {
	readonly requests: { method: string; params: unknown }[] = [];
	accept = true;

	request<T>(method: string, params?: unknown): Promise<T> {
		this.requests.push({ method, params });
		if (method === "voice.speakerEnrollmentAdd") {
			const count = this.requests.filter(request => request.method === method).length;
			return Promise.resolve({
				accepted: this.accept,
				reason: this.accept ? undefined : "Try again",
				count: this.accept ? count : count - 1,
			} as T);
		}
		if (method === "voice.speakerEnrollmentFinish") return Promise.resolve({ ok: true } as T);
		return Promise.resolve({ ok: true } as T);
	}
}

const mounted: { host: HTMLElement; root: ReturnType<typeof createRoot> }[] = [];
afterEach(() => {
	for (const { host, root } of mounted.splice(0)) {
		act(() => root.unmount());
		host.remove();
	}
});

function harness() {
	const rpc = new FakeRpc();
	let finishCapture!: (value: { pcm: Float32Array } | null) => void;
	const capture = () => ({
		done: new Promise<{ pcm: Float32Array } | null>(resolve => {
			finishCapture = resolve;
		}),
		stop: () => finishCapture(null),
	});
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	mounted.push({ host, root });
	act(() => {
		root.render(
			createElement(SpeakerEnrollment, { open: true, onClose: () => {}, rpc: rpc as unknown as RpcClient, capture }),
		);
	});
	return {
		rpc,
		host: document.body,
		finish: (clip: Float32Array | null) => finishCapture(clip ? { pcm: clip } : null),
	};
}

async function record(host: HTMLElement, finish: (clip: Float32Array | null) => void): Promise<void> {
	const primary = host.querySelector<HTMLButtonElement>(".gui-voice-enroll-primary")!;
	await act(async () => primary.click());
	await act(async () => finish(new Float32Array(64_000).fill(0.1)));
}

describe("speaker enrollment", () => {
	test("four accepted clips preserve progress and independent verification completes", async () => {
		const { rpc, host, finish } = harness();
		for (let count = 1; count <= 4; count++) {
			await record(host, finish);
			expect(host.querySelectorAll("[data-complete='true']").length).toBe(count);
		}
		await record(host, finish);
		expect(rpc.requests.filter(request => request.method === "voice.speakerEnrollmentAdd").length).toBe(4);
		expect(rpc.requests.filter(request => request.method === "voice.speakerEnrollmentFinish").length).toBe(1);
		expect(host.textContent).toContain("Voice ready");
	});

	test("reopening after completion starts a fresh enrollment", async () => {
		const { host, finish } = harness();
		for (let count = 0; count < 5; count++) await record(host, finish);
		expect(host.querySelector(".gui-voice-enroll-primary")).toBeNull();
		const root = mounted.at(-1)!.root;
		act(() => root.render(createElement(SpeakerEnrollment, { open: false, onClose: () => {}, rpc: null })));
		act(() => root.render(createElement(SpeakerEnrollment, { open: true, onClose: () => {}, rpc: null })));
		expect(host.querySelector(".gui-voice-enroll-primary")).not.toBeNull();
		expect(host.querySelector(".gui-voice-enroll-progress")?.getAttribute("aria-valuenow")).toBe("0");
	});

	test("a rejected clip retries only the current prompt", async () => {
		const { rpc, host, finish } = harness();
		await record(host, finish);
		rpc.accept = false;
		await record(host, finish);
		expect(host.querySelectorAll("[data-complete='true']").length).toBe(1);
		expect(host.textContent).toContain("Try again");
		rpc.accept = true;
		await record(host, finish);
		expect(host.querySelectorAll("[data-complete='true']").length).toBe(2);
	});

	test("reduced motion retains equivalent textual progress and a stable progress region", async () => {
		const { host, finish } = harness();
		document.documentElement.classList.add("gui-motion-off");
		const progress = host.querySelector(".gui-voice-enroll-progress");
		expect(progress).not.toBeNull();
		expect(progress?.getAttribute("role")).toBe("progressbar");
		await record(host, finish);
		expect(progress?.getAttribute("aria-valuenow")).toBe("1");
		expect(host.querySelector(".gui-voice-enroll-prompt")).not.toBeNull();
		document.documentElement.classList.remove("gui-motion-off");
	});
});
