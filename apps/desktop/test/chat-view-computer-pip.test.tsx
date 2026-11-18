// Geometry regression: the desktop's floating composer is `position: absolute`
// and the transcript wrap runs underneath it. The picture-in-picture must be
// lifted by the composer's measured height, or the card (and the collapsed
// thumbnail) end up inside the input's clickable area.
import "./happy-dom-shim";
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ChatView } from "../src/components/ChatView";
import { invalidateGitStatus } from "../src/lib/git-status-cache";
import type { RpcClient } from "../src/lib/rpc";
import { GuiSessionStore } from "../src/lib/session-store";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

/** Body of the first rule whose selector text matches. */
function rule(css: string, selector: string): string | null {
	const at = css.indexOf(selector);
	if (at < 0) return null;
	const open = css.indexOf("{", at);
	const close = css.indexOf("}", open);
	return open < 0 || close < 0 ? null : css.slice(open + 1, close);
}

const rpc = {
	request: async (method: string) => {
		if (method.startsWith("models.list")) return [];
		if (method === "git.branches") return { error: "not a repository" };
		return {};
	},
	addEventListener: () => () => {},
} as unknown as RpcClient;

// 1280×720 default layout, as measured in review: the transcript box owns the
// body (bottom 716) and the floating composer sits over its lower 105px.
const WRAP = { x: 20, y: 60, width: 1240, height: 656 };
const COMPOSER = { x: 20, y: 611, width: 1240, height: 105 };
const EXPANDED_HEIGHT = 259;
const COLLAPSED_HEIGHT = 48;
const CARD_WIDTH = 320;
const CARD_GAP = 12;

interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

function intersects(a: Rect, b: Rect): boolean {
	return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function view(store: GuiSessionStore | null) {
	return (
		<ChatView
			store={store}
			rpc={rpc}
			onSend={() => {}}
			onStop={() => {}}
			onDecideApproval={() => {}}
			busy={false}
			project="C:/workspace"
			onProject={() => {}}
			onSubmitNewSession={() => {}}
			rightPanelOpen={false}
			terminalOpen={false}
			focusMode={false}
			onToggleFocus={() => {}}
			sessionInfoOpen
			onToggleSessionInfo={() => {}}
		/>
	);
}

afterEach(() => {
	vi.restoreAllMocks();
	invalidateGitStatus();
	localStorage.clear();
});

describe("ChatView computer preview geometry", () => {
	it("keeps the card and the thumbnail clear of the floating composer", async () => {
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
			if (this.classList.contains("gui-composer-wrap")) {
				return new DOMRect(COMPOSER.x, COMPOSER.y, COMPOSER.width, COMPOSER.height);
			}
			if (this.classList.contains("gui-transcript-wrap") || this.classList.contains("gui-pip-host")) {
				return new DOMRect(WRAP.x, WRAP.y, WRAP.width, WRAP.height);
			}
			// The card's own box follows the shipped rule:
			// bottom = host bottom − (--chat-composer-inset + 12px).
			if (this.classList.contains("cvp")) {
				const host = this.closest<HTMLElement>(".gui-pip-host");
				const inset = Number.parseFloat(host?.style.getPropertyValue("--chat-composer-inset") ?? "0") || 0;
				const height = this.getAttribute("data-expanded") === "false" ? COLLAPSED_HEIGHT : EXPANDED_HEIGHT;
				const bottom = WRAP.y + WRAP.height - (inset + CARD_GAP);
				return new DOMRect(WRAP.x + WRAP.width - CARD_GAP - CARD_WIDTH, bottom - height, CARD_WIDTH, height);
			}
			return new DOMRect(0, 0, 800, 400);
		});

		const tool = {
			toolCallId: "call-1",
			toolName: "computer",
			args: {},
			startedAt: 1,
			partialResult: {
				content: [],
				details: {
					screenshots: [],
					inputEvents: [{ kind: "click", title: "Notes" }],
					viewer: { data: "AAAA", mimeType: "image/png", width: 480, height: 300, target: "desktop", at: 1 },
				},
			},
		};
		const store = new GuiSessionStore("session-1", { entries: [], cursor: 0, activeTools: [tool] }, "C:/workspace");
		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		try {
			await act(async () => root.render(view(store)));

			const pipHost = host.querySelector<HTMLElement>(".gui-pip-host")!;
			expect(pipHost).not.toBeNull();
			// The host is a composer-inset reader: the floating composer's
			// measured height lands on it as the custom property the card uses.
			expect(pipHost.style.getPropertyValue("--chat-composer-inset")).toBe(`${COMPOSER.height}px`);

			const card = host.querySelector<HTMLElement>(".cvp")!;
			expect(card.getAttribute("data-expanded")).toBe("true");
			const expanded = card.getBoundingClientRect();
			expect(intersects(expanded, COMPOSER)).toBe(false);
			// The whole card clears the composer, not just its caption.
			expect(expanded.y + expanded.height).toBeLessThanOrEqual(COMPOSER.y);

			// Collapsed thumbnail: same lift, so it is visible and clickable.
			const collapse = card.querySelector<HTMLButtonElement>(".cvp-icon")!;
			await act(async () => collapse.click());
			const thumb = host.querySelector<HTMLElement>(".cvp")!;
			expect(thumb.getAttribute("data-expanded")).toBe("false");
			const collapsed = thumb.getBoundingClientRect();
			expect(intersects(collapsed, COMPOSER)).toBe(false);
			expect(collapsed.y + collapsed.height).toBeLessThanOrEqual(COMPOSER.y);
		} finally {
			await act(async () => root.unmount());
			host.remove();
			store.dispose();
		}
	});

	// happy-dom does not lay CSS out, so the geometry above only proves the
	// wiring. The lift itself must be pinned to the shipped stylesheet: the
	// desktop rule has to raise the card by the composer's measured height,
	// not rest on the shell's default offset.
	it("lifts the card with the composer inset in the desktop stylesheet", () => {
		const base = rule(read("packages/client-core/src/components/shell/shell.css"), ".cvp {");
		expect(base, "shell .cvp base rule missing").not.toBeNull();
		expect(base).toContain("bottom: 12px");

		const lifted = rule(read("apps/desktop/src/styles/gui-chat.css"), ".gui-pip-host .cvp {");
		expect(lifted, "desktop .gui-pip-host .cvp rule missing").not.toBeNull();
		expect(lifted).toContain("calc(var(--chat-composer-inset");
		expect(lifted).toContain("+ 12px");
	});
});
