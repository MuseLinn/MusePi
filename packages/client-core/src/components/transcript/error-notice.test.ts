import { describe, expect, test } from "bun:test";
import { splitErrorText } from "./error-notice";

/**
 * The split decides what a user reads without clicking. Two things it must never
 * do: drop the tail of a long provider body (the provider's own message is
 * usually at the end), or invent a classification from message text — provider
 * phrasing changes, so shape is the only stable signal.
 */
describe("splitErrorText", () => {
	test("returns nothing for an absent or blank message", () => {
		expect(splitErrorText(undefined)).toEqual({ summary: "", detail: "" });
		expect(splitErrorText("")).toEqual({ summary: "", detail: "" });
		expect(splitErrorText("   \n  ")).toEqual({ summary: "", detail: "" });
	});

	test("keeps a short single line whole", () => {
		expect(splitErrorText("429 insufficient balance, top up required")).toEqual({
			summary: "429 insufficient balance, top up required",
			detail: "",
		});
	});

	test("folds the tail of a single long line rather than cutting it away", () => {
		// A real envelope carries a param, a code and a request id, which runs past
		// any readable width — and the provider's own message sits in the middle of
		// it, so a fixed-column truncation would be what the user actually reads.
		const body =
			'400 {"error":{"message":"The requested model is not supported for this organization and may have been retired.","type":"invalid_request_error","param":"model","code":"model_not_supported","request_id":"req_01J8Z4K2P7XQ3M9N5R6T7V8W9Y","documentation_url":"https://example.invalid/errors/model_not_supported"}}';
		const { summary, detail } = splitErrorText(body);

		expect(summary.length).toBeLessThan(body.length);
		expect(summary.endsWith("…")).toBe(true);
		// The contract is that nothing is lost: what the visible half drops is
		// exactly what the folded half keeps, so the two reassemble the input.
		expect(detail.length).toBeGreaterThan(0);
		expect(`${summary.replace("…", "")}${detail}`.replace(/\s+/g, "")).toBe(body.replace(/\s+/g, ""));
	});

	test("cuts on a space so the visible half stays readable", () => {
		const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
		const { summary } = splitErrorText(words);

		expect(summary).not.toContain("word59");
		// No mid-word cut: the head ends on a token boundary.
		expect(summary.replace("…", "")).toMatch(/word\d+$/);
	});

	test("takes the first line as the summary and folds the rest", () => {
		// This is the shape the captured-response merge produces: the status line,
		// then the provider body and code on their own lines.
		const raw = "429 余额不足或无可用资源包,请充值。\ninsufficient balance (type=1113)";
		expect(splitErrorText(raw)).toEqual({
			summary: "429 余额不足或无可用资源包,请充值。",
			detail: "insufficient balance (type=1113)",
		});
	});

	test("drops blank lines rather than folding them", () => {
		expect(splitErrorText("first\n\n\n  \nsecond")).toEqual({ summary: "first", detail: "second" });
	});

	test("hard-cuts text with no spaces instead of losing it", () => {
		const body = "x".repeat(400);
		const { summary, detail } = splitErrorText(body);

		expect(summary.length).toBeLessThanOrEqual(221);
		expect(detail.length).toBeGreaterThan(0);
		expect(`${summary.replace("…", "")}${detail}`).toBe(body);
	});
});
