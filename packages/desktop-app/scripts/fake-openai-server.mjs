/**
 * Offline fake OpenAI-compatible endpoint for the Escape-guard verification.
 *
 * Streams a slow SSE completion so the GUI has a genuinely running turn
 * (store.working === true) to interrupt — no provider credentials and no
 * user quota involved.
 *
 * Usage: bun packages/desktop-app/test/fake-openai-server.mjs
 */
const PORT = 8499;
/** Seconds of streaming per request — long enough to drive Escape probes. */
const STREAM_SECONDS = Number(process.env.FAKE_STREAM_SECONDS ?? 45);

const server = Bun.serve({
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);
		if (!url.pathname.endsWith("/chat/completions")) {
			return new Response("not found", { status: 404 });
		}
		const stream = new ReadableStream({
			async start(controller) {
				const enc = new TextEncoder();
				const send = chunk => controller.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`));
				const id = "chatcmpl-fake";
				send({
					id,
					object: "chat.completion.chunk",
					created: Math.floor(Date.now() / 1000),
					model: "fake-slow",
					choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
				});
				const words = "working".repeat(40).split("");
				const perChar = (STREAM_SECONDS * 1000) / words.length;
				for (const ch of words) {
					await Bun.sleep(perChar);
					send({
						id,
						object: "chat.completion.chunk",
						created: Math.floor(Date.now() / 1000),
						model: "fake-slow",
						choices: [{ index: 0, delta: { content: ch }, finish_reason: null }],
					});
				}
				send({
					id,
					object: "chat.completion.chunk",
					created: Math.floor(Date.now() / 1000),
					model: "fake-slow",
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				});
				controller.enqueue(enc.encode("data: [DONE]\n\n"));
				controller.close();
			},
		});
		return new Response(stream, {
			headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
		});
	},
});

console.log(`fake openai endpoint on http://127.0.0.1:${server.port}/v1 (stream ${STREAM_SECONDS}s)`);
