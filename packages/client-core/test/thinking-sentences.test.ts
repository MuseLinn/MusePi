import { describe, expect, it } from "bun:test";
import { splitThinkingSentences } from "../src/components/transcript/thinking-sentences";

describe("splitThinkingSentences", () => {
	it("splits prose on sentence punctuation", () => {
		const out = splitThinkingSentences("First sentence. Second one! Third?\n\nAnother paragraph.");
		expect(out).toEqual(["First sentence.", "Second one!", "Third?", "Another paragraph."]);
	});

	it("keeps a fenced code block whole even when it contains a sentence boundary", () => {
		const text =
			'Here is the shape:\n```json\n{\n  "id": "task_YOUR_TASK_ID",\n  ...\n}\n```\n\nThen the next sentence.';
		const out = splitThinkingSentences(text);
		expect(out).toHaveLength(3);
		expect(out[0]).toBe("Here is the shape:");
		expect(out[1]).toBe('```json\n{\n  "id": "task_YOUR_TASK_ID",\n  ...\n}\n```');
		expect(out[2]).toBe("Then the next sentence.");
	});

	it("does not split a fence on comment punctuation like '. '", () => {
		const text = "Reasoning.\n```python\n# note. keep together\nprint('x')\n```\nResolved.";
		const out = splitThinkingSentences(text);
		expect(out).toHaveLength(3);
		expect(out[1]).toBe("```python\n# note. keep together\nprint('x')\n```");
	});

	it("keeps an unterminated fence as one unit to the end", () => {
		const text = 'Start.\n```json\n{ "a": 1 }';
		const out = splitThinkingSentences(text);
		expect(out).toHaveLength(2);
		expect(out[1]).toBe('```json\n{ "a": 1 }');
	});

	it("handles multiple fences and interleaved prose", () => {
		const text = "One.\n```\na\n```\nTwo.\n```\nb\n```\nThree.";
		const out = splitThinkingSentences(text);
		expect(out).toEqual(["One.", "```\na\n```", "Two.", "```\nb\n```", "Three."]);
	});

	it("returns [] for empty or blank input", () => {
		expect(splitThinkingSentences("")).toEqual([]);
		expect(splitThinkingSentences("   \n  ")).toEqual([]);
	});
});
