import fs from "node:fs";
import readline from "node:readline";

const product = process.env.FAKE_PRODUCT;
const scenario = process.env.FAKE_SCENARIO ?? "success";
const send = (value: unknown): void => {
	process.stdout.write(`${JSON.stringify(value)}\n`);
};

if (product === "codex") {
	let turn = 0;
	const lines = readline.createInterface({ input: process.stdin });
	lines.on("line", line => {
		if (process.env.FAKE_CAPTURE) fs.appendFileSync(process.env.FAKE_CAPTURE, `${line}\n`);
		const message = JSON.parse(line) as {
			id?: number;
			method?: string;
			params?: { input?: Array<{ text?: string }> };
		};
		if (message.method === "initialize") {
			send({ id: message.id, result: { userAgent: "fake-codex" } });
			return;
		}
		if (message.method === "thread/start") {
			send({ id: message.id, result: { thread: { id: "thread-1" } } });
			return;
		}
		if (message.method === "turn/start") {
			turn += 1;
			send({ id: message.id, result: { turn: { id: `turn-${turn}`, status: "inProgress" } } });
			if (scenario === "hold") return;
			if (scenario === "approval") {
				send({
					id: 9001,
					method: "item/commandExecution/requestApproval",
					params: { availableDecisions: ["decline"] },
				});
			}
			send({
				method: "item/agentMessage/delta",
				params: { turnId: `turn-${turn}`, delta: "commentary", phase: "commentary" },
			});
			send({
				method: "item/agentMessage/delta",
				params: { turnId: `turn-${turn}`, delta: "codex answer", phase: "final_answer" },
			});
			send({ method: "turn/completed", params: { turn: { id: `turn-${turn}`, status: "completed" } } });
			return;
		}
		if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: "unknown method" } });
	});
} else {
	if (scenario === "hold") {
		setInterval(() => {}, 1000);
	} else if (scenario === "malformed") {
		process.stdout.write("not-json\n");
	} else if (scenario === "nonzero") {
		process.stderr.write("native failure");
		process.exit(7);
	} else if (scenario === "empty") {
		process.exit(0);
	} else if (scenario === "product-error") {
		send({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["denied"], result: "" });
	} else if (product === "claude" || product === "codebuddy") {
		send({ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } });
		send({ type: "result", subtype: "success", is_error: false, result: `${product} answer` });
	} else if (product === "kimi") {
		send({ role: "assistant", content: "kimi " });
		send({ role: "assistant", content: "answer" });
	} else if (product === "opencode") {
		send({ type: "text", part: { text: "opencode " } });
		send({ type: "text", part: { text: "answer" } });
	}
}
