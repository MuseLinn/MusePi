import { describe, expect, it } from "bun:test";
import { ChannelCommandHandler, type ChannelOps } from "../src/channels/handler";
import { HuaweiTodayChannel } from "../src/channels/huawei-today";
import { ChannelRegistry } from "../src/channels/registry";
import type { ChannelAdapter, ChannelHost, ChannelKind } from "../src/channels/types";

function mockOps(): ChannelOps & {
	sent: { sessionId: string; text: string; images?: { data: string; mimeType: string }[] }[];
} {
	const sent: { sessionId: string; text: string; images?: { data: string; mimeType: string }[] }[] = [];
	return {
		sent,
		listSessions: async () => [
			{ id: "s1", title: "first" },
			{ id: "s2", title: "second" },
		],
		startSession: async prompt => {
			const id = `s${prompt ? "new" : "new-empty"}`;
			if (prompt) sent.push({ sessionId: id, text: prompt });
			return id;
		},
		stopSession: async () => {},
		currentSessionId: () => "s1",
		sendPrompt: async (sessionId, text, images) => {
			sent.push({ sessionId, text, images });
		},
	};
}

describe("channel command handler", () => {
	it("routes plain text to the bound session after /switch", async () => {
		const ops = mockOps();
		const replies: { from: string; text: string }[] = [];
		const h = new ChannelCommandHandler(ops, async (_kind, from, text) => {
			replies.push({ from, text });
		});
		await h.handleIncoming("wechat", "chat-1", "/switch s2");
		expect(replies.some(r => r.text === "Bound to s2")).toBe(true);
		await h.handleIncoming("wechat", "chat-1", "hello agent");
		expect(ops.sent).toEqual([{ sessionId: "s2", text: "hello agent" }]);
	});

	it("/new binds and starts a session; /list replies with sessions", async () => {
		const ops = mockOps();
		const replies: string[] = [];
		const h = new ChannelCommandHandler(ops, async (_k, _f, text) => {
			replies.push(text);
		});
		await h.handleIncoming("wechat", "chat-2", "/new summarize this repo");
		expect(ops.sent).toEqual([{ sessionId: "snew", text: "summarize this repo" }]);
		expect(replies[0]).toContain("Session started");
		await h.handleIncoming("wechat", "chat-2", "/list");
		expect(replies.at(-1)).toContain("s1");
		expect(replies.at(-1)).toContain("s2");
	});

	it("unbound plain text asks to bind first", async () => {
		const ops = mockOps();
		const replies: string[] = [];
		const h = new ChannelCommandHandler(ops, async (_k, _f, text) => {
			replies.push(text);
		});
		await h.handleIncoming("discord", "u-1", "hello");
		expect(ops.sent).toEqual([]);
		expect(replies[0]).toContain("/new");
	});

	it("replies route through the kind the message came from", async () => {
		const ops = mockOps();
		const kinds: string[] = [];
		const h = new ChannelCommandHandler(ops, async (kind, _from, _text) => {
			kinds.push(kind);
		});
		await h.handleIncoming("telegram", "t-1", "/help");
		expect(kinds).toEqual(["telegram"]);
	});

	it("forwards image attachments to the bound session", async () => {
		const ops = mockOps();
		const h = new ChannelCommandHandler(ops, async () => {});
		await h.handleIncoming("discord", "chat-9", "/switch s1");
		await h.handleIncoming("discord", "chat-9", "analyze this", [{ data: "aGVsbG8=", mimeType: "image/png" }]);
		expect(ops.sent).toEqual([
			{ sessionId: "s1", text: "analyze this", images: [{ data: "aGVsbG8=", mimeType: "image/png" }] },
		]);
	});
});

describe("channel registry", () => {
	class FakeAdapter implements ChannelAdapter {
		readonly kind: ChannelKind;
		state: "off" | "connected" | "error" = "off";
		started = 0;
		stopped = 0;
		constructor(kind: ChannelKind) {
			this.kind = kind;
		}
		async start(): Promise<void> {
			this.started++;
			this.state = "connected";
		}
		async stop(): Promise<void> {
			this.stopped++;
			this.state = "off";
		}
		async send(): Promise<void> {}
		status() {
			return { kind: this.kind, state: this.state, config: {} };
		}
		async configure(): Promise<void> {}
	}

	const tmp = `${import.meta.dir}/.channels-test.json`;

	it("start/stop persists enabled state and drives the adapter", async () => {
		const fake = new FakeAdapter("discord");
		const host: ChannelHost = { handleIncoming: async () => {} };
		const registry = new ChannelRegistry({
			configPath: tmp,
			host,
			factories: { discord: () => fake },
		});
		const started = await registry.start("discord");
		expect(started.state).toBe("connected");
		expect(fake.started).toBe(1);
		await registry.stop("discord");
		expect(fake.stopped).toBe(1);
		// Persisted enabled=true → a fresh startAll reconnects.
		await registry.start("discord");
		expect(fake.started).toBe(2);
		await registry.startAll();
		expect(fake.started).toBe(3);
	});

	it("list() merges runtime status config over persisted config", async () => {
		// Regression (wechat QR never rendered): the runtime config returned by
		// status() — qrUrl, masked secrets — must survive list(); persisted
		// raw user config must not leak over it.
		const fake = new FakeAdapter("discord");
		fake.status = () => ({
			kind: "discord",
			state: "connected",
			config: { token: "••••9876", qrUrl: "data:image/png;base64,QQ==" },
		});
		const host: ChannelHost = { handleIncoming: async () => {} };
		const registry = new ChannelRegistry({
			configPath: `${import.meta.dir}/.channels-test-list.json`,
			host,
			factories: { discord: () => fake },
		});
		registry.configure("discord", { token: "raw-secret-token", note: "user note" });
		const [st] = registry.list();
		expect(st.config.qrUrl).toBe("data:image/png;base64,QQ==");
		expect(st.config.token).toBe("••••9876"); // masked wins — raw secret never surfaces
		expect(st.config.note).toBe("user note"); // non-conflicting persisted fields survive
		expect(st.config.enabled).toBe(false);
	});
});

describe("huawei today channel", () => {
	it("rejects start without apiKey/uid", async () => {
		const c = new HuaweiTodayChannel();
		await expect(c.start()).rejects.toThrow(/apiKey|uid/);
		expect(c.status().state).toBe("error");
	});

	it("configures and connects with apiKey/uid; masks secrets in status", async () => {
		const c = new HuaweiTodayChannel();
		await c.configure({ apiKey: "secret-key-1234", uid: "u-42" });
		await c.start();
		expect(c.status().state).toBe("connected");
		const cfg = c.status().config;
		expect(cfg.apiKey).toContain("1234");
		expect(cfg.apiKey).not.toContain("secret-key");
		expect(cfg.uid).toBe("u-42");
	});

	it("send fails when not connected", async () => {
		const c = new HuaweiTodayChannel();
		await c.configure({ apiKey: "k", uid: "u" });
		await expect(c.send({ text: "hi" })).rejects.toThrow(/not connected/);
	});
});
