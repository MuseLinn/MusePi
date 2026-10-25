import "./happy-dom-shim";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { t } from "@musepi/client-core";
import type { WidgetTask } from "@musepi/client-core/src/widgets/task";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AnnouncementOverlay } from "../src/components/AnnouncementOverlay";
import { BoardPage } from "../src/components/BoardPage";
import { DialogFrame } from "../src/components/DialogFrame";
import { OnboardingOverlay } from "../src/components/OnboardingOverlay";
import { SketchPad } from "../src/components/SketchPad";
import { TaskModal } from "../src/components/TaskModal";
import { BOARDS_KEY } from "../src/lib/board-model";
import { DONE_KEY } from "../src/lib/onboarding";
import type { RpcClient } from "../src/lib/rpc";

const roots: Root[] = [];
const TASK: WidgetTask = { enabled: true, name: "Daily sync", desc: "Sync data", runs: [], schedule: "daily" };
const ONBOARDING_DONE_BEFORE_TESTS = localStorage.getItem(DONE_KEY);

function mount(node: ReactNode): Root {
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push(root);
	act(() => root.render(node));
	return root;
}

afterEach(() => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root) act(() => root.unmount());
	}
	document.body.innerHTML = "";
	localStorage.removeItem(BOARDS_KEY);
	if (ONBOARDING_DONE_BEFORE_TESTS === null) localStorage.removeItem(DONE_KEY);
	else localStorage.setItem(DONE_KEY, ONBOARDING_DONE_BEFORE_TESTS);
});

describe("private desktop overlays", () => {
	test("only the top TaskModal handles Escape", async () => {
		const closed: string[] = [];
		mount(
			<>
				<TaskModal task={TASK} update={() => {}} onClose={() => closed.push("bottom")} />
				<TaskModal task={TASK} update={() => {}} onClose={() => closed.push("top")} />
			</>,
		);

		act(() => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		});
		await act(async () => Bun.sleep(180));

		expect(closed).toEqual(["top"]);
	});

	test("a nested dialog owns Escape without dismissing onboarding", () => {
		localStorage.removeItem(DONE_KEY);
		let dialogCloseCount = 0;
		mount(
			<>
				<OnboardingOverlay rpc={null} providerEvent={null} />
				<DialogFrame open onClose={() => dialogCloseCount++} label="Nested dialog">
					<button type="button">Nested action</button>
				</DialogFrame>
			</>,
		);

		act(() => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		});

		expect(dialogCloseCount).toBe(1);
		expect(document.querySelector(".gui-onboarding-backdrop--closing") === null).toBe(true);
	});

	test("Board focus names an empty title, closes on Escape and restores focus", async () => {
		localStorage.setItem(
			BOARDS_KEY,
			JSON.stringify([
				{
					id: "board-1",
					title: "Board",
					widgets: [{ id: "widget-1", type: "metric", title: "", data: {}, pos: { x: 0, y: 0, w: 340, h: 200 } }],
				},
			]),
		);
		mount(<BoardPage onBack={() => {}} />);
		const board = document.querySelector<HTMLButtonElement>(".gui-board-home-card");
		if (!board) throw new Error("board card did not render");
		act(() => board.click());
		await act(async () => Bun.sleep(180));
		const opener = document.querySelector<HTMLButtonElement>(".gui-board-card-actions > button");
		if (!opener) throw new Error("focus opener did not render");
		opener.focus();
		act(() => opener.click());
		const dialog = document.querySelector(".gui-board-focus");
		if (!dialog) throw new Error("focus modal did not open");
		expect(dialog.getAttribute("aria-label")).toBe(t("settings.widgetTitle"));

		act(() => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		});
		await act(async () => Bun.sleep(180));

		expect(document.querySelector(".gui-board-focus") === null).toBe(true);
		expect(document.activeElement === opener).toBe(true);
	});

	test("only the top SketchPad handles Escape", () => {
		const closed: string[] = [];
		mount(
			<>
				<SketchPad onDone={() => {}} onClose={() => closed.push("bottom")} />
				<SketchPad onDone={() => {}} onClose={() => closed.push("top")} />
			</>,
		);

		act(() => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		});

		expect(closed).toEqual(["top"]);
	});

	test("a nested dialog owns Escape without dismissing the announcement", async () => {
		localStorage.setItem(DONE_KEY, "1");
		const rpc = {
			request: async (method: string) =>
				method === "changelog.startup"
					? { markdown: "## [1.2.3]\n\n### Added\n- **New feature**\n  - EN: New feature" }
					: { latest: null },
		} as unknown as RpcClient;
		const root = mount(<AnnouncementOverlay rpc={rpc} />);
		await act(async () => Bun.sleep(20));
		if (!document.querySelector(".gui-announcement-card")) throw new Error("announcement did not open");
		let dialogCloseCount = 0;
		act(() =>
			root.render(
				<>
					<AnnouncementOverlay rpc={rpc} />
					<DialogFrame open onClose={() => dialogCloseCount++} label="Nested dialog">
						<button type="button">Nested action</button>
					</DialogFrame>
				</>,
			),
		);

		act(() => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		});

		expect(dialogCloseCount).toBe(1);
		expect(document.querySelector(".gui-announcement-card.gui-onboarding-card--closing") === null).toBe(true);
	});

	test("a nested dialog owns Escape without dismissing the reward", async () => {
		localStorage.setItem(DONE_KEY, "1");
		const rpc = {
			request: async (method: string) =>
				method === "changelog.startup" ? { reward: { id: "reward-1", amount: 25 } } : { latest: null },
		} as unknown as RpcClient;
		const root = mount(<AnnouncementOverlay rpc={rpc} />);
		await act(async () => Bun.sleep(20));
		if (!document.querySelector(".gui-reward-card")) throw new Error("reward did not open");
		let dialogCloseCount = 0;
		act(() =>
			root.render(
				<>
					<AnnouncementOverlay rpc={rpc} />
					<DialogFrame open onClose={() => dialogCloseCount++} label="Nested dialog">
						<button type="button">Nested action</button>
					</DialogFrame>
				</>,
			),
		);

		act(() => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		});

		expect(dialogCloseCount).toBe(1);
		expect(document.querySelector(".gui-reward-card--closing") === null).toBe(true);
	});

	test("reward traps focus, exposes dialog ARIA and restores its opener", async () => {
		localStorage.setItem(DONE_KEY, "1");
		const opener = document.createElement("button");
		document.body.appendChild(opener);
		opener.focus();
		const rpc = {
			request: async (method: string) =>
				method === "changelog.startup" ? { reward: { id: "reward-1", amount: 25 } } : { latest: null },
		} as unknown as RpcClient;
		mount(<AnnouncementOverlay rpc={rpc} />);
		await act(async () => Bun.sleep(20));
		const card = document.querySelector<HTMLElement>(".gui-reward-card");
		if (!card) throw new Error("reward did not open");
		const replay = card.querySelector<HTMLElement>(".gui-reward-skybtn--replay");
		const secondary = card.querySelector<HTMLElement>(".gui-reward-secondary");
		if (!replay || !secondary) throw new Error("reward actions did not render");

		expect(document.activeElement === replay).toBe(true);
		expect(card.getAttribute("role")).toBe("dialog");
		expect(card.getAttribute("aria-modal")).toBe("true");
		expect(card.getAttribute("aria-label")).toBe(t("reward.rewardClaimSuccess"));
		act(() => {
			document.activeElement?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }),
			);
		});
		expect(document.activeElement === secondary).toBe(true);
		act(() => {
			document.activeElement?.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
			);
		});
		expect(document.activeElement === replay).toBe(true);

		act(() => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		});
		await act(async () => Bun.sleep(400));
		expect(document.querySelector(".gui-reward-card") === null).toBe(true);
		expect(document.activeElement === opener).toBe(true);
		opener.remove();
	});

	test("switching reward to markdown activates announcement modal focus", async () => {
		localStorage.setItem(DONE_KEY, "1");
		const rpc = {
			request: async (method: string, params?: { force?: boolean }) =>
				method === "changelog.startup"
					? params?.force
						? { markdown: "## [1.2.3]\n\n### Added\n- **New feature**\n  - EN: New feature" }
						: { reward: { id: "reward-1", amount: 25 } }
					: { latest: null },
		} as unknown as RpcClient;
		mount(<AnnouncementOverlay rpc={rpc} />);
		await act(async () => Bun.sleep(20));
		if (!document.querySelector(".gui-reward-card")) throw new Error("reward did not open");

		act(() => {
			window.dispatchEvent(new Event("musepi-open-announcement"));
		});
		await act(async () => Bun.sleep(20));
		const card = document.querySelector<HTMLElement>(".gui-announcement-card");
		if (!card) throw new Error("markdown announcement did not open");
		expect(card.contains(document.activeElement)).toBe(true);
	});

	test("changes the onboarding marker so suite cleanup must restore its incoming value", () => {
		localStorage.setItem(DONE_KEY, ONBOARDING_DONE_BEFORE_TESTS === "1" ? "0" : "1");
	});
});

afterAll(() => {
	expect(localStorage.getItem(DONE_KEY)).toBe(ONBOARDING_DONE_BEFORE_TESTS);
});
