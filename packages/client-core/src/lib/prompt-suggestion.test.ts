import { describe, expect, test } from "bun:test";
import {
	clearPromptSuggestion,
	getPromptSuggestion,
	setPromptSuggestion,
	subscribePromptSuggestions,
	visiblePromptSuggestion,
} from "./prompt-suggestion";

describe("prompt suggestion store", () => {
	test("a candidate is scoped to its own session", () => {
		setPromptSuggestion("a", "Run the tests.");
		expect(getPromptSuggestion("a")).toBe("Run the tests.");
		expect(getPromptSuggestion("b")).toBeNull();
		clearPromptSuggestion("a");
	});

	test("publishing trims the text and drops an empty one", () => {
		setPromptSuggestion("a", "  Run the tests.  ");
		expect(getPromptSuggestion("a")).toBe("Run the tests.");
		setPromptSuggestion("a", "   ");
		expect(getPromptSuggestion("a")).toBeNull();
	});

	test("subscribers hear every real change and nothing else", () => {
		let notifications = 0;
		const unsubscribe = subscribePromptSuggestions(() => {
			notifications += 1;
		});
		setPromptSuggestion("a", "Run the tests.");
		setPromptSuggestion("a", "Run the tests.");
		setPromptSuggestion("", "ignored");
		expect(notifications).toBe(1);
		clearPromptSuggestion("a");
		expect(notifications).toBe(2);
		clearPromptSuggestion("a");
		expect(notifications).toBe(2);
		unsubscribe();
		setPromptSuggestion("a", "Run the tests.");
		expect(notifications).toBe(2);
		clearPromptSuggestion("a");
	});
});

describe("visiblePromptSuggestion", () => {
	const ready = { draftEmpty: true, writable: true, busy: false, blocked: false };

	test("an empty, idle, writable composer offers the candidate", () => {
		expect(visiblePromptSuggestion("Run the tests.", ready)).toBe("Run the tests.");
	});

	test("each blocking condition suppresses it", () => {
		for (const blocked of [{ draftEmpty: false }, { writable: false }, { busy: true }, { blocked: true }]) {
			expect(visiblePromptSuggestion("Run the tests.", { ...ready, ...blocked })).toBeNull();
		}
	});

	test("no candidate means no candidate", () => {
		expect(visiblePromptSuggestion(null, ready)).toBeNull();
		expect(visiblePromptSuggestion("", ready)).toBeNull();
	});
});
