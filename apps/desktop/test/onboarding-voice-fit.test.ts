import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { ensureChromiumExecutable } from "../../../packages/coding-agent/src/tools/browser/launch";

/**
 * Voice step fits the primer without scrolling (puppeteer, real cascade).
 *
 * The step carried a closing sentence that repeated the step body, plus a
 * visible "permission granted" and "model ready" sentence that repeated the
 * green tile, the border and the select's own value. Together they overflowed
 * the step's scroll viewport, so a card that fits grew a scrollbar.
 *
 * Markup mirrors `OnboardingVoiceSetup` with the shipped classes, rendered at
 * the shipped card size in BOTH locales — the widest translation wins.
 */

const STYLES = path.resolve(import.meta.dir, "../src/styles");
const CLIENT_STYLES = path.resolve(import.meta.dir, "../../../packages/client-core/src/styles");
const CASCADE = [
	path.join(CLIENT_STYLES, "tokens.css"),
	...[
		"gui-base.css",
		"gui-chrome.css",
		"gui-composer.css",
		"gui-settings.css",
		"gui-taskcenter.css",
		"gui-widgets.css",
		"gui-misc.css",
	].map(file => path.join(STYLES, file)),
]
	.map(file => fs.readFileSync(file, "utf8"))
	.join("\n");

interface Copy {
	badge: string;
	title: string;
	body: string;
	microphone: string;
	modelSelect: string;
	recommendation: string;
	voice: string;
	voiceStatus: string;
	reEnroll: string;
	next: string;
	back: string;
}

const COPIES: Record<"zh-CN" | "en-US", Copy> = {
	"zh-CN": {
		badge: "首次启动设置",
		title: "让语音输入可用",
		body: "检查麦克风和识别模型。两项可以分别设置，也可以稍后到「设置 → 语音」完成。",
		microphone: "麦克风",
		modelSelect: "SenseVoiceSmall (INT8) · 推荐",
		recommendation: "中文界面推荐：优化普通话、粤语和中英混合语音。",
		voice: "我的声纹",
		voiceStatus: "声纹已录制，语种识别会用它与你的声音比对。",
		reEnroll: "重新录入",
		next: "下一步",
		back: "返回",
	},
	"en-US": {
		badge: "First launch setup",
		title: "Enable voice input",
		body: "Check the microphone and the recognition model. They can be set separately, or finished later in Settings → Voice.",
		microphone: "Microphone",
		modelSelect: "SenseVoiceSmall (INT8) · Recommended",
		recommendation: "Recommended for the Chinese interface: Mandarin, Cantonese and mixed speech.",
		voice: "Your voice",
		voiceStatus: "Enrolled — used to match your voice for language detection.",
		reEnroll: "Re-enroll",
		next: "Next",
		back: "Back",
	},
};

const step = (copy: Copy): string => `<div class="gui-onboarding-card" style="width: 1000px; height: 620px">
	<div class="gui-onboarding-topbar"><span class="gui-onboarding-badge">${copy.badge}</span><button class="gui-onboarding-close" type="button">×</button></div>
	<div class="gui-onboarding-grid">
		<div class="gui-onboarding-pane">
			<div class="gui-onboarding-head">
				<div class="gui-onboarding-icon"></div>
				<div class="gui-onboarding-head-copy">
					<div class="gui-onboarding-title">${copy.title}</div>
					<div class="gui-onboarding-body">${copy.body}</div>
				</div>
			</div>
			<div class="gui-obo-step-body gui-fade-scroll">
				<div class="gui-obo-voice-setup">
					<section class="gui-obo-voice-check" data-state="granted">
						<span class="gui-obo-voice-check-icon"></span>
						<div class="gui-obo-voice-check-copy">
							<div class="gui-obo-voice-check-title">${copy.microphone}</div>
							<div class="gui-obo-voice-device"><div class="gui-voice-device-control"><div class="gui-voice-device"><button class="gui-btn" type="button"><span class="gui-voice-device-label">System default</span></button></div><div class="gui-voice-input-meter"><span style="width: 38%"></span></div></div></div>
						</div>
					</section>
					<section class="gui-obo-voice-check" data-state="ready">
						<span class="gui-obo-voice-check-icon"></span>
						<div class="gui-obo-voice-check-copy">
							<div class="gui-obo-voice-check-title">${copy.modelSelect.split(" · ")[0] ? "Recognition model" : ""}</div>
							<button class="gui-select-trigger gui-obo-voice-model-select" type="button"><span class="gui-seg-item-label">${copy.modelSelect}</span></button>
							<p class="gui-obo-voice-recommendation">${copy.recommendation}</p>
						</div>
					</section>
					<section class="gui-obo-voice-check" data-state="ready">
						<span class="gui-obo-voice-check-icon"></span>
						<div class="gui-obo-voice-check-copy">
							<div class="gui-obo-voice-check-title">${copy.voice}</div>
							<p>${copy.voiceStatus}</p>
						</div>
						<button class="gui-btn" type="button">${copy.reEnroll}</button>
					</section>
				</div>
			</div>
			<div class="gui-onboarding-dots"><span class="gui-onboarding-dot"></span><span class="gui-onboarding-dot"></span><span class="gui-onboarding-dot"></span><span class="gui-onboarding-dot gui-onboarding-dot--active"></span><span class="gui-onboarding-dot"></span></div>
			<div class="gui-onboarding-actions"><button class="gui-btn gui-btn-ghost" type="button">${copy.back}</button><button class="gui-btn gui-btn-primary gui-onboarding-next" type="button">${copy.next}</button></div>
		</div>
		<div class="gui-onboarding-visual"></div>
	</div>
</div>`;

const ROOT = `
	:root {
		--bg: rgb(18, 18, 18);
		--bg-raised: rgb(26, 26, 26);
		--bg-overlay: rgb(30, 30, 30);
		--color-bg: rgb(18, 18, 18);
		--color-surface: rgb(32, 32, 32);
		--color-surface-raised: rgb(40, 40, 40);
		--color-surface-sunken: rgb(24, 24, 24);
		--color-text: rgb(235, 235, 235);
		--color-text-muted: rgb(170, 170, 170);
		--color-text-faint: rgb(130, 130, 130);
		--color-accent: rgb(212, 165, 66);
		--color-accent-bd: rgb(150, 120, 60);
		--color-ok: rgb(80, 190, 120);
		--color-danger: rgb(220, 90, 90);
		--ok: rgb(80, 190, 120);
		--err: rgb(220, 90, 90);
		--fg: rgb(235, 235, 235);
		--fg-muted: rgb(175, 175, 175);
		--fg-faint: rgb(135, 135, 135);
		--accent: rgb(212, 165, 66);
		--accent-hover: rgb(225, 180, 80);
		--accent-fg: rgb(20, 20, 20);
		--border: rgb(70, 70, 70);
		--glass-border: rgb(90, 90, 90);
		--glass-bg-strong: rgb(30 30 30 / 72%);
		--glass-sheen: linear-gradient(0deg, transparent, transparent);
		--glass-shadow: 0 0 0 0 transparent;
		--radius-sm: 4px;
		--radius-md: 6px;
		--radius-lg: 8px;
		--radius-xl: 12px;
		--radius-2xl: 20px;
		--space-1: 4px;
		--space-3: 12px;
		--control-height-sm: 32px;
		--ui-font-size: 14px;
		--ui-font-size-sm: 13px;
		--ui-font-size-xs: 11px;
		--spring: cubic-bezier(0.32, 0.72, 0, 1);
		--spring-liquid: cubic-bezier(0.34, 1.56, 0.64, 1);
		--spring-snappy: cubic-bezier(0.3, 1.2, 0.5, 1);
		--gui-motion-fade-in: 160ms;
		--gui-glass-blur: 0px;
		--gui-glass-saturate: 100%;
	}
	body { margin: 0; background: #080808; }
	${CASCADE}
`;

let browser: Browser;
let page: Page;

beforeAll(async () => {
	const executablePath = await ensureChromiumExecutable();
	if (!executablePath) throw new Error("No Chromium executable resolved");
	browser = await puppeteer.launch({ executablePath, headless: true });
	page = await browser.newPage();
	await page.setViewport({ width: 1100, height: 760 });
});

afterAll(async () => {
	await browser?.close();
});

const measure = (copy: Copy) =>
	page.evaluate(
		(markup: string, root: string) => {
			document.head.innerHTML = `<style>${root}</style>`;
			document.body.innerHTML = markup;
			const body = document.querySelector<HTMLElement>(".gui-obo-step-body");
			if (!body) throw new Error("no step body");
			return {
				scroll: body.scrollHeight,
				client: body.clientHeight,
				content: document.querySelector<HTMLElement>(".gui-obo-voice-setup")?.getBoundingClientRect().height ?? 0,
			};
		},
		step(copy),
		ROOT,
	);

describe("the voice step fits its container", () => {
	// A scrollbar for content that could be stated once is the reported defect;
	// the widest locale decides whether the card fits at its shipped size.
	for (const locale of ["zh-CN", "en-US"] as const) {
		test(`${locale}: no vertical overflow in the step body`, async () => {
			const result = await measure(COPIES[locale]);
			expect(result.scroll, `content ${result.content}px`).toBeLessThanOrEqual(result.client);
			// Headroom, not a knife-edge pass: the card also has to absorb a
			// larger UI font scale without growing a scrollbar.
			// Measured slack: 65px (zh) / 48px (en) at the shipped card size. Half of
			// that is the floor so a longer translation or a larger font scale still
			// fits without bringing the scrollbar back.
			expect(result.client - result.content, "content slack").toBeGreaterThanOrEqual(24);
		});
	}
});
