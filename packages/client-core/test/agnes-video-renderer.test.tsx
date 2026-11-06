import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { setLocale } from "../src/i18n";
import { agnesVideoGenRenderer } from "../src/tool-render/tools/agnes-video-gen";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
setLocale("en-US");
afterAll(() => void GlobalRegistrator.unregister());

const roots: Root[] = [];
afterEach(() => {
	while (roots.length) act(() => roots.pop()!.unmount());
	document.body.innerHTML = "";
});

function mount(node: ReactNode): HTMLElement {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push(root);
	act(() => root.render(node));
	return host;
}

const Body = agnesVideoGenRenderer.Body!;
const Summary = agnesVideoGenRenderer.Summary;

describe("agnes_video_gen renderer", () => {
	test("plays the generated video from details.videoUrl", () => {
		const host = mount(
			createElement(Body, {
				name: "agnes_video_gen",
				args: { prompt: "a cat surfing" },
				result: {
					content: [{ type: "text", text: "done" }],
					details: {
						taskId: "t1",
						videoId: "v1",
						status: "succeeded",
						videoUrl: "https://cdn.example/clip.mp4",
						durationSeconds: 5,
						size: "1280x720",
					},
				},
			}),
		);
		const video = host.querySelector<HTMLVideoElement>("video.tv-video");
		expect(video?.getAttribute("src")).toBe("https://cdn.example/clip.mp4");
		expect(video?.getAttribute("controls")).not.toBeNull();
		expect(host.textContent).toContain("a cat surfing");
		expect(host.textContent).toContain("1280x720");
	});

	test("an async handle shows progress instead of an empty player", () => {
		const host = mount(
			createElement(Body, {
				name: "agnes_video_gen",
				args: { prompt: "a cat surfing" },
				result: {
					content: [{ type: "text", text: "backgrounded" }],
					details: { taskId: "t1", videoId: "v1", status: "queued", async: { state: "running", jobId: "j1" } },
				},
			}),
		);
		expect(host.querySelector("video")).toBeNull();
		expect(host.textContent).toContain("Generating video");
	});

	test("the summary names the prompt and status", () => {
		const host = mount(
			createElement(Summary, {
				name: "agnes_video_gen",
				args: { prompt: "a cat surfing" },
				result: { content: [], details: { status: "running", progress: 42 } },
			}),
		);
		expect(host.textContent).toContain("a cat surfing");
		expect(host.textContent).toContain("42%");
	});
});
