import "./happy-dom-shim";
import { afterEach, describe, expect, it } from "bun:test";
import {
	readWelcomeGreeting,
	resolveWelcomeGreeting,
	WELCOME_GREETING_CHANGED_EVENT,
	WELCOME_GREETING_STORAGE_KEY,
	writeWelcomeGreeting,
} from "../src/lib/welcome-greeting";

afterEach(() => {
	localStorage.removeItem(WELCOME_GREETING_STORAGE_KEY);
});

describe("welcome greeting preference", () => {
	it("uses a non-blank custom greeting and preserves the default for blank input", () => {
		expect(resolveWelcomeGreeting("你好，小袁总", "Good evening")).toBe("你好，小袁总");
		expect(resolveWelcomeGreeting("   ", "Good evening")).toBe("Good evening");
	});

	it("persists edits and notifies the mounted welcome page", () => {
		let notifications = 0;
		const onChanged = (): void => {
			notifications += 1;
		};
		window.addEventListener(WELCOME_GREETING_CHANGED_EVENT, onChanged);
		writeWelcomeGreeting("欢迎回来");
		window.removeEventListener(WELCOME_GREETING_CHANGED_EVENT, onChanged);
		expect(readWelcomeGreeting()).toBe("欢迎回来");
		expect(notifications).toBe(1);
	});
});
