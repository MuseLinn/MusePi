/**
 * computer + vibe renderer tests: the computer card shows the screenshot
 * grid and the action code; vibe spawn/send render the composer-style
 * message with a pending/settled status, wait lists settled rows, and the
 * status icon morphs pending → settled.
 */
import { describe, expect, it } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ToolRenderProps } from "../src/tool-render/types";
import { computerRenderer } from "../src/tool-render/tools/computer";
import { vibeRenderer } from "../src/tool-render/tools/vibe";

const renderComp = (props: ToolRenderProps) =>
	renderToStaticMarkup((computerRenderer.Body as (p: ToolRenderProps) => ReactNode)(props));
const renderVibe = (props: ToolRenderProps) =>
	renderToStaticMarkup((vibeRenderer.Body as (p: ToolRenderProps) => ReactNode)(props));

describe("computer renderer", () => {
	const result = {
		content: [],
		details: {
			code: 'mouse.click({ x: 640, y: 360 })',
			screenshots: [
				{ path: "/tmp/shot1.png", width: 1440, height: 900, target: "data:image/png;base64,AAAA" },
			],
			backend: "darwin",
			readOnly: false,
		},
	};

	it("renders the screenshot grid with data-url sources and the action code", () => {
		const html = renderComp({ args: {}, result } as never);
		expect(html).toContain("tv-imgs");
		expect(html).toContain("data:image/png;base64,AAAA");
		expect(html).toContain("mouse.click");
		expect(html).toContain("tv-out-title");
	});

	it("shows the failed note on errors", () => {
		const html = renderComp({ args: {}, result: { ...result, isError: true } } as never);
		expect(html).toContain("tv-note--err");
		expect(html).toContain("Desktop action failed");
	});
});

describe("vibe renderer", () => {
	it("spawn renders the composer message with a pending status while booting", () => {
		const html = renderVibe({
			args: { op: "spawn", cli: "agents", prompt: "analyze the repo" },
			result: { content: [], details: { op: "spawn", screens: [] } },
		} as never);
		expect(html).toContain("analyze the repo");
		expect(html).toContain("tv-vibe-message");
		expect(html).toContain("tv-vibe-status");
	});

	it("spawn switches to the settled status once the spawned record lands", () => {
		const html = renderVibe({
			args: { op: "spawn", cli: "agents" },
			result: {
				content: [],
				details: { op: "spawn", screens: [], spawned: { id: "s1", cli: "agents", jobId: "j1" } },
			},
		} as never);
		expect(html).toContain("tv-vibe-status");
		expect(html).not.toContain("vibe booting");
	});

	it("wait lists settled rows with status badges", () => {
		const html = renderVibe({
			args: { op: "wait", sessions: ["s1"] },
			result: {
				content: [],
				details: {
					op: "wait",
					screens: [],
					wait: { settled: [{ id: "s1", jobId: "j1", status: "completed" }], stillRunning: [], timedOut: false },
				},
			},
		} as never);
		expect(html).toContain("completed");
		expect(html).toContain("tv-badge");
	});

	it("wait flags still-running sessions and timeouts", () => {
		const html = renderVibe({
			args: { op: "wait", sessions: ["s1", "s2"] },
			result: {
				content: [],
				details: {
					op: "wait",
					screens: [],
					wait: { settled: [], stillRunning: ["s2"], timedOut: true },
				},
			},
		} as never);
		expect(html).toContain("still running: s2");
		expect(html).toContain("wait timed out");
	});
});
