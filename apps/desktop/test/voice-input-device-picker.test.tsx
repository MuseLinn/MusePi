import "./happy-dom-shim";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { getLocaleSnapshot, setLocale } from "@musepi/client-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { VoiceInputDevicePicker } from "../src/components/VoiceInputDevicePicker";

interface FakeDevice {
	deviceId: string;
	label: string;
	kind: string;
}

class FakeStream {
	readonly stop = vi.fn();
	getTracks(): Array<{ stop(): void }> {
		return [{ stop: this.stop }];
	}
}

class FakeAudioContext {
	static instances: FakeAudioContext[] = [];
	readonly source = { connect: vi.fn(), disconnect: vi.fn() };
	readonly analyser = {
		fftSize: 0,
		smoothingTimeConstant: 0,
		disconnect: vi.fn(),
		getByteTimeDomainData: (samples: Uint8Array) => samples.fill(160),
	};
	readonly resume = vi.fn(() => Promise.resolve());
	readonly close = vi.fn(() => Promise.resolve());

	constructor() {
		FakeAudioContext.instances.push(this);
	}

	createMediaStreamSource(_stream: MediaStream): typeof this.source {
		return this.source;
	}

	createAnalyser(): typeof this.analyser {
		return this.analyser;
	}
}

class FakeMediaDevices {
	devices: FakeDevice[];
	readonly streams: FakeStream[] = [];
	readonly listeners = new Set<() => void>();
	onGetUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
	readonly getUserMedia = vi.fn((constraints: MediaStreamConstraints): Promise<MediaStream> => {
		if (this.onGetUserMedia) return this.onGetUserMedia(constraints);
		const stream = new FakeStream();
		this.streams.push(stream);
		return Promise.resolve(stream as unknown as MediaStream);
	});
	readonly enumerateDevices = vi.fn(() => Promise.resolve(this.devices as unknown as MediaDeviceInfo[]));

	constructor(devices: FakeDevice[]) {
		this.devices = devices;
	}

	addEventListener(type: string, listener: () => void): void {
		if (type === "devicechange") this.listeners.add(listener);
	}

	removeEventListener(type: string, listener: () => void): void {
		if (type === "devicechange") this.listeners.delete(listener);
	}

	emitDeviceChange(): void {
		for (const listener of this.listeners) listener();
	}
}

let host: HTMLDivElement;
let root: Root;
let media: FakeMediaDevices;
let previousLocale: ReturnType<typeof getLocaleSnapshot>;
let mediaDescriptor: PropertyDescriptor | undefined;
let audioDescriptor: PropertyDescriptor | undefined;
let rafDescriptor: PropertyDescriptor | undefined;
let cancelRafDescriptor: PropertyDescriptor | undefined;
let nextFrame = 1;
let frames: Map<number, FrameRequestCallback>;

beforeEach(() => {
	previousLocale = getLocaleSnapshot();
	setLocale("en-US");
	localStorage.clear();
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	mediaDescriptor = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
	audioDescriptor = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
	rafDescriptor = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
	cancelRafDescriptor = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
	FakeAudioContext.instances = [];
	frames = new Map();
	nextFrame = 1;
	Object.defineProperty(globalThis, "AudioContext", { configurable: true, writable: true, value: FakeAudioContext });
	Object.defineProperty(globalThis, "requestAnimationFrame", {
		configurable: true,
		writable: true,
		value: (callback: FrameRequestCallback): number => {
			const id = nextFrame++;
			frames.set(id, callback);
			return id;
		},
	});
	Object.defineProperty(globalThis, "cancelAnimationFrame", {
		configurable: true,
		writable: true,
		value: (id: number) => frames.delete(id),
	});
	media = new FakeMediaDevices([
		{ deviceId: "default-mic", label: "Default Mic", kind: "audioinput" },
		{ deviceId: "desk", label: "Desk Mic", kind: "audioinput" },
	]);
	Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: media });
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	localStorage.clear();
	setLocale(previousLocale);
	if (mediaDescriptor) Object.defineProperty(navigator, "mediaDevices", mediaDescriptor);
	else Reflect.deleteProperty(navigator, "mediaDevices");
	for (const [name, descriptor] of [
		["AudioContext", audioDescriptor],
		["requestAnimationFrame", rafDescriptor],
		["cancelAnimationFrame", cancelRafDescriptor],
	] as const) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
});

async function flush(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	});
}

async function render(active: boolean): Promise<void> {
	act(() => root.render(<VoiceInputDevicePicker active={active} />));
	await flush();
}

function meter(): HTMLElement {
	return host.querySelector<HTMLElement>("[role='meter']")!;
}

describe("VoiceInputDevicePicker", () => {
	it("shows a live level and stops the old stream when the selected device changes", async () => {
		await render(true);
		expect(meter().getAttribute("aria-valuenow")).toBe("100");
		expect(media.streams).toHaveLength(2);
		expect(media.streams[1]!.stop).toHaveBeenCalledTimes(1);

		act(() => host.querySelector<HTMLButtonElement>(".gui-voice-device > button")!.click());
		const option = [...document.body.querySelectorAll<HTMLButtonElement>("[role='menuitemradio']")].find(button =>
			button.textContent?.includes("Desk Mic"),
		)!;
		act(() => option.click());
		await flush();

		expect(localStorage.getItem("musepi-voice-input-device")).toBe("desk");
		expect(media.streams[0]!.stop).toHaveBeenCalledTimes(1);
		expect(FakeAudioContext.instances[0]!.close).toHaveBeenCalledTimes(1);
		expect(media.getUserMedia).toHaveBeenLastCalledWith({ audio: { deviceId: { exact: "desk" } } });
	});

	it("refreshes on devicechange and falls back when the selected device disappears", async () => {
		localStorage.setItem("musepi-voice-input-device", "desk");
		await render(true);
		media.devices = [{ deviceId: "usb", label: "USB Mic", kind: "audioinput" }];
		act(() => media.emitDeviceChange());
		await flush();

		expect(localStorage.getItem("musepi-voice-input-device")).toBeNull();
		expect(host.querySelector(".gui-voice-device-label")?.textContent).toBe("System default");
		expect(media.getUserMedia).toHaveBeenLastCalledWith({ audio: true });
		act(() => host.querySelector<HTMLButtonElement>(".gui-voice-device > button")!.click());
		expect(document.body.textContent).toContain("USB Mic");
		expect(document.body.textContent).not.toContain("Desk Mic");
	});

	it("reports microphone permission denial", async () => {
		media.onGetUserMedia = () => Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
		await render(true);
		expect(host.querySelector("[role='status']")?.textContent).toContain("Microphone permission denied");
	});

	it("releases tracks, audio nodes, context, and animation frames when inactive", async () => {
		await render(true);
		const stream = media.streams[0]!;
		const context = FakeAudioContext.instances[0]!;
		expect(frames.size).toBeGreaterThan(0);

		await render(false);
		expect(stream.stop).toHaveBeenCalledTimes(1);
		expect(context.source.disconnect).toHaveBeenCalledTimes(1);
		expect(context.analyser.disconnect).toHaveBeenCalledTimes(1);
		expect(context.close).toHaveBeenCalledTimes(1);
		expect(frames.size).toBe(0);
		expect(meter().getAttribute("aria-valuenow")).toBe("0");
	});

	it("stops a pending stream immediately when it arrives after deactivation", async () => {
		let resolveLate!: (stream: MediaStream) => void;
		const late = new Promise<MediaStream>(resolve => {
			resolveLate = resolve;
		});
		let calls = 0;
		media.onGetUserMedia = constraints => {
			calls++;
			if (calls === 1) return late;
			const stream = new FakeStream();
			media.streams.push(stream);
			return Promise.resolve(stream as unknown as MediaStream);
		};
		await render(true);
		await render(false);
		const lateStream = new FakeStream();
		resolveLate(lateStream as unknown as MediaStream);
		await flush();

		expect(lateStream.stop).toHaveBeenCalledTimes(1);
		expect(FakeAudioContext.instances).toHaveLength(0);
	});
});
