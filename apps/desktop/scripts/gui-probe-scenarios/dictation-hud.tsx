import { createElement } from "react";
import { DictationHudView } from "../../src/components/dictation-hud";
import { measure, mount } from "../gui-probe-helpers";

const transcript = "第一句已经定稿。第二句正在实时识别，随着语音继续增长，卡片应该换行并保持在有界高度内，不能遮挡其他应用。";

export default {
	"dictation-hud-streaming": {
		capture: ".hud",
		async render(root) {
			await mount(
				createElement(
					"div",
					{ style: { width: 300, boxSizing: "border-box", padding: "4px 4px 8px" } },
					createElement(DictationHudView, { state: { phase: "recording", seconds: 6, level: 0.6, partialText: transcript } }),
				),
				root,
			);
		},
		async measure(body) {
			const detail = body.querySelector<HTMLElement>(".hud-sub--transcript");
			const hud = body.querySelector<HTMLElement>(".hud");
			if (!detail || !hud) throw new Error("streaming HUD did not render");
			if (getComputedStyle(detail).whiteSpace !== "normal") throw new Error("transcript must wrap instead of ellipsizing");
			if (detail.getBoundingClientRect().height > 62) throw new Error("transcript exceeded its three-line bound");
			if (hud.scrollWidth > hud.clientWidth) throw new Error("HUD overflowed horizontally");
			return { elements: measure(body, { hud: ".hud", detail: ".hud-sub--transcript", cancel: ".hud-btn" }) };
		},
		expect: {
			hud: { "box.w": { max: 300 }, "box.h": { min: 60, max: 150 } },
			detail: { "box.h": { min: 30, max: 62 } },
			cancel: { display: "block" },
		},
	},
} satisfies Record<string, GuiScenario>;

type GuiScenario = import("../gui-probe-helpers").GuiScenario;
