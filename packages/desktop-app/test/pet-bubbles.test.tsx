import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PetActivity, PetSessionCard } from "../src/lib/pet";
import type { PetBubbles as PetBubblesComponent } from "../src/pet-bubbles";
import { defineGlobal } from "./define-global";

type ActivityListener = (payload: PetActivity) => void;

const roots: Root[] = [];
let PetBubbles: typeof PetBubblesComponent;
let ownsDomRegistration = false;

beforeAll(async () => {
	if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
	defineGlobal("document", { body: {}, head: {}, documentElement: {} } as unknown as Document);
	const wasRegistered = GlobalRegistrator.isRegistered;
	const hasRealDom = typeof document !== "undefined" && typeof document.addEventListener === "function";
	if (wasRegistered && !hasRealDom) await GlobalRegistrator.unregister();
	if (!GlobalRegistrator.isRegistered) GlobalRegistrator.register();
	ownsDomRegistration = !wasRegistered || !hasRealDom;
	(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
	({ PetBubbles } = await import("../src/pet-bubbles"));
});

afterAll(async () => {
	if (ownsDomRegistration) await GlobalRegistrator.unregister();
	if (!GlobalRegistrator.isRegistered) await GlobalRegistrator.register();
	expect(GlobalRegistrator.isRegistered).toBe(true);
});

afterEach(() => {
	while (roots.length > 0) {
		const root = roots.pop();
		if (root) act(() => root.unmount());
	}
	document.body.innerHTML = "";
	delete (window as unknown as Record<string, unknown>).electronAPI;
});

function mountBubbles(): {
	push(payload: PetActivity): void;
	advance(): void;
	opens: string[];
	visibility: boolean[];
	reads: string[];
	allReads: number[];
	approvals: Array<{ requestId: string; approved: boolean }>;
} {
	const activityListeners: ActivityListener[] = [];
	const advanceListeners: Array<() => void> = [];
	const opens: string[] = [];
	const visibility: boolean[] = [];
	const reads: string[] = [];
	const allReads: number[] = [];
	const approvals: Array<{ requestId: string; approved: boolean }> = [];
	(window as unknown as Record<string, unknown>).electronAPI = {
		onPetActivity(callback: ActivityListener) {
			activityListeners.push(callback);
			return () => {};
		},
		onBubblesAdvance(callback: () => void) {
			advanceListeners.push(callback);
			return () => {};
		},
		petOpenSession(sessionId: string) {
			opens.push(sessionId);
			return Promise.resolve();
		},
		petMarkRead(sessionId: string) {
			reads.push(sessionId);
			return Promise.resolve();
		},
		petMarkAllRead() {
			allReads.push(1);
			return Promise.resolve();
		},
		petApprove(requestId: string, approved: boolean) {
			approvals.push({ requestId, approved });
			return Promise.resolve();
		},
		setBubblesVisible(visible: boolean) {
			visibility.push(visible);
			return Promise.resolve();
		},
		setBubblesContentSize() {
			return Promise.resolve();
		},
		setBubblesHitbox() {
			return Promise.resolve();
		},
		bubblesSetMode() {
			return Promise.resolve();
		},
		requestPetState() {
			return Promise.resolve();
		},
	};
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = createRoot(host);
	roots.push(root);
	act(() => root.render(createElement(PetBubbles)));
	return {
		push(payload) {
			act(() => {
				for (const listener of activityListeners) listener(payload);
			});
		},
		advance() {
			act(() => {
				for (const listener of advanceListeners) listener();
			});
		},
		opens,
		visibility,
		reads,
		allReads,
		approvals,
	};
}

const firstCard: PetSessionCard = {
	sessionId: "main-session",
	title: "Main session",
	phase: "done",
	statusText: "Completed",
};
const secondCard: PetSessionCard = {
	sessionId: "background-session",
	title: "Background session",
	phase: "working",
	statusText: "Working",
};

describe("desktop pet bubble state transitions", () => {
	test("an expanded card opens its session instead of collapsing the list", () => {
		const bridge = mountBubbles();
		bridge.push({ sessions: [firstCard, secondCard] });
		const stackedBody = document.querySelector<HTMLElement>(".pet-bubbles--stacked .pet-bubble__body");
		expect(stackedBody).not.toBeNull();
		act(() => stackedBody!.click());
		expect(document.querySelector(".pet-bubbles--expanded")).not.toBeNull();

		const expandedBody = document.querySelector<HTMLElement>(
			".pet-bubbles--expanded .pet-bubble--session .pet-bubble__body",
		);
		act(() => expandedBody!.click());

		expect(bridge.opens).toEqual(["main-session"]);
		expect(document.querySelector(".pet-bubbles--expanded")).not.toBeNull();
	});

	test("the pet-side toggle advances expanded, stacked and count in one place", () => {
		const bridge = mountBubbles();
		bridge.push({ sessions: [firstCard, secondCard] });
		expect(document.querySelector(".pet-bubbles--stacked")).not.toBeNull();

		bridge.advance();
		expect(document.querySelector(".pet-bubbles")).toBeNull();
		expect(bridge.visibility.at(-1)).toBe(false);

		bridge.advance();
		expect(document.querySelector(".pet-bubbles--stacked")).not.toBeNull();
		act(() => document.querySelector<HTMLElement>(".pet-bubbles--stacked .pet-bubble__body")!.click());
		expect(document.querySelector(".pet-bubbles--expanded")).not.toBeNull();

		bridge.advance();
		expect(document.querySelector(".pet-bubbles--stacked")).not.toBeNull();
	});

	test("a new activity takes priority once without repeated snapshots stealing it", () => {
		const bridge = mountBubbles();
		bridge.push({ sessions: [secondCard] });
		bridge.push({ sessions: [secondCard, firstCard] });
		const topTitle = () =>
			document.querySelector(".pet-bubbles--stacked > .pet-bubble .pet-bubble__title")?.textContent;
		expect(topTitle()).toBe("Main session");

		bridge.push({ sessions: [firstCard, secondCard] });
		expect(topTitle()).toBe("Main session");
		const failedSecond = { ...secondCard, phase: "error" as const, activityKey: "turn-2" };
		bridge.push({ sessions: [firstCard, failedSecond] });
		expect(topTitle()).toBe("Background session");
		bridge.push({ sessions: [failedSecond, firstCard] });
		expect(topTitle()).toBe("Background session");
	});

	test("count mode reopens only for a new activity revision", () => {
		const bridge = mountBubbles();
		const firstTurn = { ...firstCard, activityKey: "turn-1" };
		bridge.push({ sessions: [firstTurn] });
		bridge.advance();
		expect(document.querySelector(".pet-bubbles")).toBeNull();

		bridge.push({ sessions: [firstTurn] });
		expect(document.querySelector(".pet-bubbles")).toBeNull();
		bridge.push({ sessions: [{ ...firstTurn, activityKey: "turn-2" }] });
		expect(document.querySelector(".pet-bubbles--stacked")).not.toBeNull();
	});

	test("clear all suppresses the current activities without reads or approvals", () => {
		const bridge = mountBubbles();
		const firstTurn = { ...firstCard, activityKey: "turn-1" };
		const approval = { requestId: "request-1", tool: "bash" };
		bridge.push({ sessions: [firstTurn], approval });
		act(() => document.querySelector<HTMLElement>(".pet-bubbles--stacked > .pet-bubble")!.click());
		act(() => document.querySelector<HTMLElement>(".pet-bubbles__clear")!.click());
		expect(bridge.reads).toEqual([]);
		expect(bridge.allReads).toEqual([]);
		expect(bridge.approvals).toEqual([]);
		expect(document.querySelector(".pet-bubbles")).toBeNull();

		bridge.push({ sessions: [firstTurn], approval });
		expect(document.querySelector(".pet-bubbles")).toBeNull();
		bridge.push({
			sessions: [{ ...firstTurn, activityKey: "turn-2" }],
			approval: { requestId: "request-2", tool: "bash" },
		});
		expect(document.querySelectorAll(".pet-bubble").length).toBe(1);
		act(() => document.querySelector<HTMLElement>(".pet-bubbles--stacked > .pet-bubble")!.click());
		expect(document.querySelectorAll(".pet-bubbles--expanded .pet-bubble").length).toBe(2);
		expect(bridge.reads).toEqual([]);
		expect(bridge.allReads).toEqual([]);
		expect(bridge.approvals).toEqual([]);
	});

	test("confirming a finished card marks its session read in the main window", () => {
		const bridge = mountBubbles();
		bridge.push({ sessions: [firstCard] });
		act(() => document.querySelector<HTMLElement>(".pet-bubble--session .pet-bubble__action--primary")!.click());
		expect(bridge.reads).toEqual(["main-session"]);
		expect(document.querySelector(".pet-bubbles")).toBeNull();
	});

	test("dismissing one card remembers only its current activity and keeps it unread", () => {
		const bridge = mountBubbles();
		const firstTurn = { ...firstCard, activityKey: "turn-1" };
		bridge.push({ sessions: [firstTurn] });
		act(() => document.querySelector<HTMLElement>(".pet-bubble--session .pet-bubble__dismiss")!.click());
		expect(bridge.reads).toEqual([]);
		expect(document.querySelector(".pet-bubbles")).toBeNull();

		bridge.push({ sessions: [firstTurn] });
		expect(document.querySelector(".pet-bubbles")).toBeNull();
		bridge.push({ sessions: [{ ...firstTurn, activityKey: "turn-2" }] });
		expect(document.querySelector(".pet-bubbles--stacked")).not.toBeNull();
		expect(bridge.reads).toEqual([]);
	});
});
