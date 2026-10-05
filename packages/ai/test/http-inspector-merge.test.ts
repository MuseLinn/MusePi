import { describe, expect, test } from "bun:test";
import { type CapturedHttpErrorResponse, finalizeErrorMessage } from "../src/utils/http-inspector";

/**
 * The captured response is folded into the provider's own message so the user can
 * see the status code and provider code, not just a transport string. The one
 * hazard is printing the provider's text twice: deduplication has to compare the
 * captured body, because the decorated form carries a (type=… code=…) suffix the
 * provider's message never had.
 */
describe("finalizeErrorMessage captured-response merge", () => {
	test("does not repeat a provider message that already states the captured body", async () => {
		// Reproduces a 429 quota rejection: the provider's error message is the
		// captured body, prefixed with the status and followed by the provider code.
		const body = "余额不足或无可用资源包,请充值。";
		const captured: CapturedHttpErrorResponse = {
			status: 429,
			bodyJson: { error: { message: body, type: "1113" } },
			bodyText: JSON.stringify({ error: { message: body, type: "1113" } }),
		};
		const providerError = new Error(`429 ${body}`);

		const message = await finalizeErrorMessage(providerError, undefined, captured);

		// The body must appear once, and the provider code must still be present.
		expect(message.split(body)).toHaveLength(2);
		expect(message).toContain("type=1113");
	});

	test("still appends the captured body when the provider said something else", async () => {
		// Deduping on the body must not suppress a genuinely different message —
		// this is the case the merge exists for.
		const captured: CapturedHttpErrorResponse = {
			status: 400,
			bodyJson: { error: { message: "invalid reasoning value", type: "invalid_request_error" } },
			bodyText: JSON.stringify({ error: { message: "invalid reasoning value", type: "invalid_request_error" } }),
		};
		const providerError = new Error("request failed");

		const message = await finalizeErrorMessage(providerError, undefined, captured);

		expect(message).toContain("request failed");
		expect(message).toContain("invalid reasoning value");
		expect(message).toContain("type=invalid_request_error");
	});

	test("prefers the captured body when the provider reported no body", async () => {
		const captured: CapturedHttpErrorResponse = {
			status: 400,
			bodyJson: { error: { message: "model_not_supported", code: "model_not_supported" } },
			bodyText: JSON.stringify({ error: { message: "model_not_supported", code: "model_not_supported" } }),
		};
		const providerError = new Error("status code (no body)");

		const message = await finalizeErrorMessage(providerError, undefined, captured);

		expect(message).toContain("400 status code: model_not_supported");
		// The placeholder is replaced, not prefixed.
		expect(message).not.toContain("no body");
	});
});
