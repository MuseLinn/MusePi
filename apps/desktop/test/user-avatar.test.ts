import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { defineGlobal } from "./define-global";

/**
 * 用户头像来源(lib/user-avatar.ts)的存储契约:设置页写得进、气泡读得到,
 * 且"写存储"必须广播——气泡是同步读键 + 只在事件上重渲染,漏广播就是
 * 连上 GitHub 后头像还是旧的那张。
 */

const store = new Map<string, string>();
defineGlobal("localStorage", {
	getItem: (key: string) => store.get(key) ?? null,
	setItem: (key: string, value: string) => void store.set(key, value),
	removeItem: (key: string) => void store.delete(key),
});

type Handler = (event: { type: string; key?: string | null }) => void;
const handlers = new Map<string, Set<Handler>>();

defineGlobal("window", {
	addEventListener(type: string, handler: Handler) {
		const set = handlers.get(type) ?? new Set<Handler>();
		set.add(handler);
		handlers.set(type, set);
	},
	removeEventListener(type: string, handler: Handler) {
		handlers.get(type)?.delete(handler);
	},
	dispatchEvent(event: { type: string }) {
		for (const handler of handlers.get(event.type) ?? []) handler(event);
		return true;
	},
});
defineGlobal(
	"CustomEvent",
	class {
		type: string;
		constructor(type: string) {
			this.type = type;
		}
	},
);

import {
	onUserAvatarChanged,
	readUserAvatarMode,
	readUserAvatarPrefs,
	syncUserAvatarUrl,
	USER_AVATAR_EVENT,
	USER_AVATAR_MODE_KEY,
	USER_AVATAR_URL_KEY,
	writeUserAvatarMode,
} from "../src/lib/user-avatar";

/** Count how many times `type` reaches a listener. */
function countEvents(type: string): { hits: () => number } {
	let hits = 0;
	handlers.set(type, new Set([() => void hits++]));
	return { hits: () => hits };
}

beforeEach(() => {
	store.clear();
	handlers.clear();
});

afterEach(() => {
	store.clear();
	handlers.clear();
});

describe("readUserAvatarMode", () => {
	it("defaults to auto when nothing is stored", () => {
		expect(readUserAvatarMode()).toBe("auto");
	});

	it("keeps the two explicit picks", () => {
		store.set(USER_AVATAR_MODE_KEY, "punk");
		expect(readUserAvatarMode()).toBe("punk");
		store.set(USER_AVATAR_MODE_KEY, "initial");
		expect(readUserAvatarMode()).toBe("initial");
	});

	it("normalises an unknown stored value to auto (control never sits unselected)", () => {
		store.set(USER_AVATAR_MODE_KEY, "letter");
		expect(readUserAvatarMode()).toBe("auto");
	});
});

describe("readUserAvatarPrefs", () => {
	it("reads both keys in one call", () => {
		store.set(USER_AVATAR_MODE_KEY, "punk");
		store.set(USER_AVATAR_URL_KEY, "https://github.com/octocat.png");
		expect(readUserAvatarPrefs()).toEqual({
			mode: "punk",
			url: "https://github.com/octocat.png",
		});
	});

	it("treats an empty stored url as absent (bubble falls back, not to a blank img)", () => {
		store.set(USER_AVATAR_URL_KEY, "");
		expect(readUserAvatarPrefs().url).toBeNull();
	});
});

describe("writeUserAvatarMode", () => {
	it("persists the pick and broadcasts the change", () => {
		const events = countEvents(USER_AVATAR_EVENT);
		writeUserAvatarMode("initial");
		expect(store.get(USER_AVATAR_MODE_KEY)).toBe("initial");
		expect(events.hits()).toBe(1);
	});
});

describe("syncUserAvatarUrl", () => {
	it("writes a new picture and broadcasts once", () => {
		const events = countEvents(USER_AVATAR_EVENT);
		syncUserAvatarUrl("https://github.com/octocat.png");
		expect(store.get(USER_AVATAR_URL_KEY)).toBe("https://github.com/octocat.png");
		expect(events.hits()).toBe(1);
	});

	it("stays silent when the picture did not change (settings reopens refresh auth)", () => {
		const events = countEvents(USER_AVATAR_EVENT);
		syncUserAvatarUrl("https://github.com/octocat.png");
		syncUserAvatarUrl("https://github.com/octocat.png");
		expect(events.hits()).toBe(1);
	});

	it("clears the picture on logout and broadcasts", () => {
		const events = countEvents(USER_AVATAR_EVENT);
		syncUserAvatarUrl("https://github.com/octocat.png");
		syncUserAvatarUrl(null);
		expect(store.has(USER_AVATAR_URL_KEY)).toBe(false);
		expect(events.hits()).toBe(2);
	});

	it("does not broadcast when there was nothing to clear", () => {
		const events = countEvents(USER_AVATAR_EVENT);
		syncUserAvatarUrl(null);
		expect(events.hits()).toBe(0);
	});
});

describe("onUserAvatarChanged", () => {
	it("delivers the same-window event and stops after unsubscribe", () => {
		let hits = 0;
		const off = onUserAvatarChanged(() => void hits++);
		writeUserAvatarMode("punk");
		expect(hits).toBe(1);
		off();
		writeUserAvatarMode("auto");
		expect(hits).toBe(1);
	});

	it("follows another window's storage write for these two keys only", () => {
		let hits = 0;
		const off = onUserAvatarChanged(() => void hits++);
		window.dispatchEvent({ type: "storage", key: "musepi-gui-git-view" });
		expect(hits).toBe(0);
		window.dispatchEvent({ type: "storage", key: USER_AVATAR_MODE_KEY });
		expect(hits).toBe(1);
		window.dispatchEvent({ type: "storage", key: USER_AVATAR_URL_KEY });
		expect(hits).toBe(2);
		off();
	});
});
