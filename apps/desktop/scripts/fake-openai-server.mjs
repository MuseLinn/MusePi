/**
 * Offline fake OpenAI-compatible endpoint for the desktop GUI smokes.
 *
 * Two request shapes, chosen by the request itself:
 *
 * - Default (`FAKE_STREAM_SECONDS`): streams a slow text completion, giving the
 *   GUI a genuinely running turn to interrupt (Escape-guard, scroll probes).
 * - `FAKE_TOOL_COMMAND`: the first tool-bearing turn answers with ONE `bash`
 *   tool call carrying that command, so the turn genuinely sits inside a tool
 *   execution; a later turn (its request already carries the tool result)
 *   streams a short closing reply instead of calling the tool again.
 *
 * No provider credentials and no user quota are involved.
 *
 * Usage: bun apps/desktop/scripts/fake-openai-server.mjs
 */
// The port is overridable so two checkouts can run their own fake endpoint
// side by side; the historical fixed port stays the default for existing
// probes.
const PORT = Number(process.env.FAKE_PORT ?? 8499);
/** Seconds of streaming per request — long enough to drive Escape probes. */
const STREAM_SECONDS = Number(process.env.FAKE_STREAM_SECONDS ?? 45);
/** When set, answer the first tool-bearing turn with this bash command. */
const TOOL_COMMAND = process.env.FAKE_TOOL_COMMAND ?? "";
const MODEL = "fake-slow";
const TOOL_CALL_ID = "call_fake_bash";

const server = Bun.serve({
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);
		if (!url.pathname.endsWith("/chat/completions")) {
			return new Response("not found", { status: 404 });
		}
		let body = null;
		try {
			body = await req.json();
		} catch {
			// A probe without JSON gets the default text stream.
		}
		const messages = Array.isArray(body?.messages) ? body.messages : [];
		const offersTools = Array.isArray(body?.tools) && body.tools.length > 0;
		const hasToolResult = messages.some(message => message?.role === "tool");
		const answerWithToolCall = TOOL_COMMAND.length > 0 && offersTools && !hasToolResult;
		const stream = new ReadableStream({
			async start(controller) {
				const enc = new TextEncoder();
				const send = delta => {
					controller.enqueue(
						enc.encode(
							`data: ${JSON.stringify({
								id: "chatcmpl-fake",
								object: "chat.completion.chunk",
								created: Math.floor(Date.now() / 1000),
								model: MODEL,
								choices: [{ index: 0, delta, finish_reason: null }],
							})}\n\n`,
						),
					);
				};
				const finish = reason => {
					controller.enqueue(
						enc.encode(
							`data: ${JSON.stringify({
								id: "chatcmpl-fake",
								object: "chat.completion.chunk",
								created: Math.floor(Date.now() / 1000),
								model: MODEL,
								choices: [{ index: 0, delta: {}, finish_reason: reason }],
							})}\n\n`,
						),
					);
					controller.enqueue(enc.encode("data: [DONE]\n\n"));
					controller.close();
				};
				send({ role: "assistant", content: "" });
				if (answerWithToolCall) {
					// Opening entry names the tool; the argument JSON follows in a
					// second delta, the way hosts fragment it.
					await Bun.sleep(120);
					send({
						tool_calls: [
							{
								index: 0,
								id: TOOL_CALL_ID,
								type: "function",
								function: { name: "bash", arguments: "" },
							},
						],
					});
					await Bun.sleep(120);
					send({
						tool_calls: [
							{
								index: 0,
								function: {
									arguments: JSON.stringify({ command: TOOL_COMMAND }),
								},
							},
						],
					});
					await Bun.sleep(80);
					finish("tool_calls");
					return;
				}
				if (TOOL_COMMAND.length > 0) {
					// Post-tool turn (title generation, continuation): a short answer.
					for (const ch of "done") {
						await Bun.sleep(30);
						send({ content: ch });
					}
					finish("stop");
					return;
				}
				const words = "working".repeat(40).split("");
				const perChar = (STREAM_SECONDS * 1000) / words.length;
				for (const ch of words) {
					await Bun.sleep(perChar);
					send({ content: ch });
				}
				finish("stop");
			},
		});
		return new Response(stream, {
			headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
		});
	},
});

console.log(
	`fake openai endpoint on http://127.0.0.1:${server.port}/v1 (stream ${STREAM_SECONDS}s${
		TOOL_COMMAND ? `, tool ${JSON.stringify(TOOL_COMMAND)}` : ""
	})`,
);
