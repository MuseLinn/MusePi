import { describe, expect, it } from "bun:test";
import { captureOpenAIHttpError } from "@musepi/pi-ai/utils/openai-http";

const HTML_ERROR_PAGE = `<!DOCTYPE html>
<html lang="en-US">
<head><title>agnes-ai.cn | 504: Gateway time-out</title></head>
<body><h1>Gateway time-out</h1><p>Please try again in a few minutes.</p></body>
</html>`;

describe("captureOpenAIHttpError", () => {
	it("replaces a raw HTML error page with a concise message (body kept in captured)", async () => {
		const error = await captureOpenAIHttpError(
			new Response(HTML_ERROR_PAGE, { status: 504, statusText: "Gateway Timeout" }),
		);

		expect(error.message).toBe("504 upstream returned an HTML error page (gateway or proxy failure)");
		// Full markup stays available for debugging / strict-tools fallbacks.
		expect(error.captured.bodyText).toBe(HTML_ERROR_PAGE);
		expect(error.captured.status).toBe(504);
	});

	it("keeps the JSON envelope message for well-formed error bodies", async () => {
		const error = await captureOpenAIHttpError(
			new Response(JSON.stringify({ error: { message: "insufficient_quota", type: "quota" } }), { status: 429 }),
		);

		expect(error.message).toBe("429 insufficient_quota");
		expect(error.code).toBe("quota");
	});

	it("keeps plain-text bodies verbatim", async () => {
		const error = await captureOpenAIHttpError(new Response("upstream is warming up", { status: 503 }));

		expect(error.message).toBe("503 upstream is warming up");
	});

	it("falls back to the status-only phrasing for an empty body", async () => {
		const error = await captureOpenAIHttpError(new Response("", { status: 500 }));

		expect(error.message).toBe("500 status code (no body)");
	});
});
