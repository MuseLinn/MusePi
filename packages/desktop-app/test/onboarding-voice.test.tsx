import "./happy-dom-shim";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { getLocaleSnapshot, setLocale } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { OnboardingOverlay } from "../src/components/OnboardingOverlay";
import type { RpcClient } from "../src/lib/rpc";

class FakeRpc {
	readonly requests: { method: string; params: unknown }[] = [];
	readonly cached = new Set<string>();
	defaultKey = "balanced";
	private readonly listeners = new Set<(event: { payload: unknown }) => void>();

	request<T>(method: string, params?: unknown): Promise<T> {
		this.requests.push({ method, params });
		if (method === "stt.modelStatus") {
			return Promise.resolve({
				models: [
					{ key: "balanced", label: "Whisper Small", cached: this.cached.has("balanced") },
					{ key: "sensevoice", label: "SenseVoiceSmall", cached: this.cached.has("sensevoice") },
				],
				downloads: [],
				defaultKey: this.defaultKey,
				defaultCached: this.cached.has(this.defaultKey),
			} as T);
		}
		if (method === "settings.set") {
			const { key, value } = params as { key: string; value: string };
			if (key === "stt.modelName") this.defaultKey = value;
		}
		if (method === "import.agents") return Promise.resolve([] as T);
		return Promise.resolve({ ok: true } as T);
	}

	addEventListener(listener: (event: { payload: unknown }) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(payload: unknown): void {
		for (const listener of this.listeners) listener({ payload });
	}
}

let root: Root;
let host: HTMLDivElement;
let rpc: FakeRpc;
let previousLocale: ReturnType<typeof getLocaleSnapshot>;
let mediaDevices: PropertyDescriptor | undefined;

beforeEach(() => {
	previousLocale = getLocaleSnapshot();
	setLocale("en-US");
	localStorage.clear();
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	rpc = new FakeRpc();
	mediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	localStorage.clear();
	setLocale(previousLocale);
	if (mediaDevices) Object.defineProperty(navigator, "mediaDevices", mediaDevices);
	else Reflect.deleteProperty(navigator, "mediaDevices");
});

async function flush(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

async function mountVoiceStep(): Promise<void> {
	act(() => {
		root.render(<OnboardingOverlay rpc={rpc as unknown as RpcClient} providerEvent={null} />);
	});
	act(() => {
		window.dispatchEvent(new CustomEvent("musepi-open-onboarding", { detail: { step: 3 } }));
	});
	await flush();
}

function button(label: string): HTMLButtonElement {
	const match = [...host.querySelectorAll<HTMLButtonElement>("button")].find(item =>
		item.textContent?.includes(label),
	);
	if (!match) throw new Error(`Missing button: ${label}. Content: ${host.textContent}`);
	return match;
}

function installMicrophone(result: "ready" | "denied") {
	const stop = vi.fn();
	const getUserMedia = vi.fn(() =>
		result === "ready"
			? Promise.resolve({ getTracks: () => [{ readyState: "live", stop }] })
			: Promise.reject({ name: "NotAllowedError" }),
	);
	Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
	return { getUserMedia, stop };
}

describe("onboarding voice setup", () => {
	test("checks the microphone and follows the real model download to readiness", async () => {
		const mic = installMicrophone("ready");
		await mountVoiceStep();

		await act(async () => button("Check microphone").click());
		await flush();
		expect(mic.getUserMedia).toHaveBeenCalledTimes(1);
		expect(mic.stop).toHaveBeenCalledTimes(1);
		expect(host.textContent).toContain("Microphone ready");

		await act(async () => button("Download recognition model").click());
		expect(rpc.requests.some(request => request.method === "stt.modelDownload")).toBe(true);
		act(() => rpc.emit({ type: "stt.downloadProgress", modelKey: "balanced", percent: 40 }));
		expect(host.querySelector("progress")?.getAttribute("value")).toBe("40");

		rpc.cached.add("balanced");
		act(() => rpc.emit({ type: "stt.downloadDone", modelKey: "balanced" }));
		await flush();
		expect(host.textContent).toContain("Speech model ready");
	});

	test("recommends SenseVoice for a Chinese first run without downloading it automatically", async () => {
		setLocale("zh-CN");
		await mountVoiceStep();

		expect(host.textContent).toContain("中文界面推荐");
		expect(rpc.requests).toContainEqual({
			method: "settings.set",
			params: { key: "stt.modelName", value: "sensevoice" },
		});
		expect(rpc.requests.some(request => request.method === "stt.modelDownload")).toBe(false);
	});

	test("recommends Balanced for an English first run", async () => {
		await mountVoiceStep();

		expect(host.textContent).toContain("Recommended for multilingual input");
		expect(host.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain("Whisper Small");
		expect(rpc.requests.some(request => request.method === "stt.modelDownload")).toBe(false);
	});

	test("keeps the configured model when the guide is reopened manually", async () => {
		localStorage.setItem("musepi-gui-onboarding-done", "1");
		rpc.defaultKey = "sensevoice";
		await mountVoiceStep();

		expect(host.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain("SenseVoiceSmall");
		expect(rpc.requests.some(request => request.method === "settings.set")).toBe(false);
		expect(host.textContent).not.toContain("Recommended for multilingual input");
	});

	test("downloads only the manually selected model and preserves it across steps", async () => {
		await mountVoiceStep();
		await act(async () => button("SenseVoiceSmall").click());
		await flush();

		expect(rpc.requests).toContainEqual({
			method: "settings.set",
			params: { key: "stt.modelName", value: "sensevoice" },
		});
		await act(async () => button("Download recognition model").click());
		expect(rpc.requests).toContainEqual({ method: "stt.modelDownload", params: { modelKey: "sensevoice" } });

		act(() => rpc.emit({ type: "stt.downloadError", modelKey: "sensevoice", message: "network details" }));
		await act(async () => button("Next").click());
		await act(async () => button("Back").click());
		await flush();
		expect(host.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain("SenseVoiceSmall");
	});

	test("permission denial and download failure remain actionable without blocking navigation", async () => {
		installMicrophone("denied");
		await mountVoiceStep();

		await act(async () => button("Check microphone").click());
		await flush();
		expect(host.textContent).toContain("Microphone permission denied");

		await act(async () => button("Download recognition model").click());
		act(() => rpc.emit({ type: "stt.downloadError", modelKey: "balanced", message: "network details" }));
		expect(host.textContent).toContain("Recognition model download failed");
		expect(host.querySelector(".gui-onboarding-next")?.hasAttribute("disabled")).toBe(false);
	});
});
