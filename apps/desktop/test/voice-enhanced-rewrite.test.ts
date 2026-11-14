/**
 * Desktop enhanced read-aloud (`tts.enhanced` → tts.rewrite RPC).
 *
 * The rewrite service used to exist only inside the TUI's EventController;
 * the desktop now reaches the SAME SpeechEnhancer over RPC. Blocks are split
 * fence-aware, rewritten with bounded concurrency, and each failure falls
 * back to mechanical sanitization so a missing model never silences a reply.
 */
import "./happy-dom-shim"; // MUST be first: installs the DOM globals.
import { describe, expect, it } from "bun:test";
import { setLocale } from "@musepi/client-core";
import type { RpcClient } from "../src/lib/rpc";
import { speak, splitRewriteBlocks } from "../src/lib/voice";

setLocale("zh-CN");

type RewriteReply = { text: string | null } | Error;

class FakeRpc {
	calls: { method: string; params: Record<string, unknown> }[] = [];
	reply: (text: string) => RewriteReply = () => ({ text: "这是口语化的改写。" });

	request<T>(method: string, params?: unknown): Promise<T> {
		this.calls.push({ method, params: (params ?? {}) as Record<string, unknown> });
		if (method === "tts.rewrite") {
			const r = this.reply(String((params as { text: string }).text));
			if (r instanceof Error) return Promise.reject(r);
			return Promise.resolve(r as T);
		}
		// A failed synthesis short-circuits the audio graph; we only need to
		// observe which text reached tts.synthesize.
		return Promise.resolve({ audio: null, sampleRate: 0, error: "stop" } as T);
	}

	synthTexts(): string[] {
		return this.calls.filter(c => c.method === "tts.synthesize").map(c => String(c.params.text));
	}
	rewriteCalls(): unknown[] {
		return this.calls.filter(c => c.method === "tts.rewrite").map(c => c.params);
	}
}

const asRpc = (fake: FakeRpc): RpcClient => fake as unknown as RpcClient;
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 20));

describe("splitRewriteBlocks", () => {
	it("splits on blank lines but keeps a fenced code block whole", () => {
		const blocks = splitRewriteBlocks("第一段。\n\n```js\nconst a = 1\n\nconst b = 2\n```\n\n第二段。");
		expect(blocks).toEqual(["第一段。", "```js\nconst a = 1\n\nconst b = 2\n```", "第二段。"]);
	});

	it("keeps an unclosed fence in one block", () => {
		expect(splitRewriteBlocks("开头\n\n```\na\n\nb")).toEqual(["开头", "```\na\n\nb"]);
	});

	it("drops empty blocks", () => {
		expect(splitRewriteBlocks("\n\n  \n第一段。\n\n\n")).toEqual(["第一段。"]);
	});
});

describe("speak() enhanced path", () => {
	const markdown = "第一段。\n\n```js\nconst a = 1\n```\n\n第二段。";

	it("sends rewritten prose to synthesis, not the original markdown", async () => {
		const fake = new FakeRpc();
		speak(markdown, asRpc(fake), { enhanced: true, sessionId: "session-1" });
		await tick();
		expect(fake.rewriteCalls().length).toBe(3);
		expect(fake.synthTexts().length).toBeGreaterThan(0);
		const spoken = fake.synthTexts().join(" ");
		expect(spoken).toContain("这是口语化的改写");
		expect(spoken).not.toContain("```");
		expect(spoken).not.toContain("const a");
	});

	it("skips blocks the model judged unspeakable", async () => {
		const fake = new FakeRpc();
		fake.reply = () => ({ text: "" });
		speak("只有一段。", asRpc(fake), { enhanced: true, sessionId: "session-1" });
		await tick();
		// Every block returned "" → nothing speakable → no synthesis request.
		expect(fake.synthTexts()).toEqual([]);
	});

	it("falls back to mechanical sanitization when the rewrite fails", async () => {
		const fake = new FakeRpc();
		fake.reply = () => new Error("no tiny model");
		speak(markdown, asRpc(fake), { enhanced: true, sessionId: "session-1" });
		await tick();
		expect(fake.rewriteCalls().length).toBe(3);
		expect(fake.synthTexts().length).toBeGreaterThan(0);
		expect(fake.synthTexts().join(" ")).not.toContain("```");
	});

	it("falls back when the daemon reports no rewrite (null)", async () => {
		const fake = new FakeRpc();
		fake.reply = () => ({ text: null });
		speak("第一段。", asRpc(fake), { enhanced: true, sessionId: "session-1" });
		await tick();
		expect(fake.synthTexts().join(" ")).toContain("第一段");
	});

	it("never calls tts.rewrite when enhanced is off or no session is bound", async () => {
		const off = new FakeRpc();
		speak("第一段。", asRpc(off), { mode: "sanitize" });
		await tick();
		const noSession = new FakeRpc();
		speak("第一段。", asRpc(noSession), { enhanced: true });
		await tick();
		expect(off.rewriteCalls()).toEqual([]);
		expect(noSession.rewriteCalls()).toEqual([]);
		expect(off.synthTexts().length).toBeGreaterThan(0);
		expect(noSession.synthTexts().length).toBeGreaterThan(0);
	});

	it("keeps the content mode effective after rewriting", async () => {
		const fake = new FakeRpc();
		fake.reply = () => ({ text: "第一句是改写。第二句也是改写。第三句还是改写。" });
		speak("第一段。", asRpc(fake), { enhanced: true, sessionId: "session-1", mode: "summarize" });
		await tick();
		const spoken = fake.synthTexts().join(" ");
		expect(spoken).toContain("第一句是改写");
		// 精简（前两句）still applies after the model rewrite.
		expect(spoken).not.toContain("第三句");
	});
});
