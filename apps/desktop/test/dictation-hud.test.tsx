import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

GlobalRegistrator.register();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const { DictationHudView } = await import("../src/components/dictation-hud");
afterAll(() => void GlobalRegistrator.unregister());

describe("global dictation HUD", () => {
	test("shows one cumulative transcript through recording and transcription", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		const transcript = "第一句。第二句正在实时识别，文字应该完整保留而不会在标题里重复。";
		await act(async () =>
			root.render(
				createElement(DictationHudView, { state: { phase: "recording", seconds: 2, partialText: transcript } }),
			),
		);
		const detail = () => host.querySelector(".hud-sub");
		expect(detail()?.textContent).toContain(transcript);
		expect(detail()?.classList.contains("hud-sub--transcript")).toBe(true);
		expect(host.querySelector(".hud-title")?.textContent).not.toContain(transcript);
		expect(host.querySelectorAll("button").length).toBe(1);

		await act(async () =>
			root.render(createElement(DictationHudView, { state: { phase: "transcribing", partialText: transcript } })),
		);
		expect(detail()?.textContent).toContain(transcript);
		expect(host.querySelector(".hud-title")?.textContent).not.toContain(transcript);
		await act(async () => root.unmount());
		host.remove();
	});
});
