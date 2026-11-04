import { describe, expect, it } from "bun:test";
import {
	DEFAULT_PROMPT_LANES,
	PromptHost,
	replayPromptHostLedger,
	type ScopedPromptHostLedger,
	scopePromptHostToOwner,
} from "@musepi/pi-coding-agent/prompts/host";
import { PROMPT_ORDERS } from "@musepi/pi-coding-agent/prompts/orders";
import { PromptRegistryError } from "@musepi/pi-coding-agent/prompts/registry";

// Prompt host contract: scope inheritance, lane priority, four contribution
// kinds, cache scopes, revision, owner release and close.

describe("prompts/host empty", () => {
	it("assembles nothing and keeps revision at zero", () => {
		const host = new PromptHost();
		expect(host.revision).toBe(0);
		expect(host.closed).toBe(false);
		expect(host.assemble()).toEqual({ revision: 0, sections: [], complete: null });
		expect(host.collectContext()).toEqual([]);
	});
});

describe("prompts/host scope inheritance", () => {
	it("inherits a parent section and lets a child shadow it", () => {
		const host = new PromptHost();
		const child = host.createScope("subagent");
		host.registerSection({ name: "role", order: 10, text: "ROOT" });
		const disposeChild = host.registerSection({ name: "role", order: 10, text: "CHILD" }, { scope: child });

		expect(host.assemble().sections.map(section => section.text)).toEqual(["ROOT"]);
		expect(host.assemble({ scope: child }).sections.map(section => section.text)).toEqual(["CHILD"]);

		disposeChild();
		expect(host.assemble({ scope: child }).sections.map(section => section.text)).toEqual(["ROOT"]);
	});

	it("does not leak a sibling scope contribution", () => {
		const host = new PromptHost();
		const left = host.createScope("left");
		const right = host.createScope("right");
		host.registerSection({ name: "role", order: 10, text: "LEFT" }, { scope: left });
		expect(host.assemble({ scope: right }).sections).toEqual([]);
	});
});

describe("prompts/host lanes", () => {
	it("lets a later lane win inside one scope and restores the earlier lane on dispose", () => {
		const host = new PromptHost();
		host.registerSection({ name: "role", order: 10, text: "CORE" }, { lane: "core" });
		host.registerSection({ name: "role", order: 10, text: "EXT" }, { lane: "extension" });
		expect(host.assemble().sections.map(section => section.text)).toEqual(["EXT"]);

		const disposeSession = host.registerSection({ name: "role", order: 10, text: "SESSION" }, { lane: "session" });
		expect(host.assemble().sections.map(section => section.text)).toEqual(["SESSION"]);

		disposeSession();
		expect(host.assemble().sections.map(section => section.text)).toEqual(["EXT"]);
	});

	it("keeps scope inheritance ahead of lane priority", () => {
		const host = new PromptHost();
		const child = host.createScope("child");
		host.registerSection({ name: "role", order: 10, text: "ROOT-SESSION" }, { lane: "session" });
		host.registerSection({ name: "role", order: 10, text: "CHILD-CORE" }, { scope: child, lane: "core" });
		expect(host.assemble({ scope: child }).sections.map(section => section.text)).toEqual(["CHILD-CORE"]);
	});

	it("rejects an unknown lane without mutating the host", () => {
		const host = new PromptHost();
		const revision = host.revision;
		expect(() => host.registerSection({ name: "role", order: 10, text: "X" }, { lane: "nope" })).toThrow(
			/unknown prompt lane/,
		);
		expect(host.revision).toBe(revision);
	});

	it("supports a custom lane order", () => {
		const host = new PromptHost({ lanes: ["low", "high"] });
		host.registerSection({ name: "role", order: 10, text: "LOW" }, { lane: "low" });
		host.registerSection({ name: "role", order: 10, text: "HIGH" }, { lane: "high" });
		expect(host.assemble().sections.map(section => section.text)).toEqual(["HIGH"]);
	});
});

describe("prompts/host complete sections", () => {
	it("rejects a second visible complete section atomically", () => {
		const host = new PromptHost();
		host.registerSection({ name: "whole", order: 0, text: "ONLY", complete: true });
		const revision = host.revision;

		expect(() => host.registerSection({ name: "other", order: 10, text: "OTHER", complete: true })).toThrow(
			PromptRegistryError,
		);

		expect(host.revision).toBe(revision);
		expect(host.assemble().complete?.text).toBe("ONLY");
		expect(host.assemble().sections.map(section => section.text)).toEqual(["ONLY"]);
	});

	it("rejects a disposer that would reveal a second complete section", () => {
		const host = new PromptHost();
		const child = host.createScope("branch");
		host.registerSection({ name: "whole", order: 0, text: "ONLY", complete: true });
		const disposeShadow = host.registerSection({ name: "whole", order: 0, text: "PARTIAL" }, { scope: child });
		const disposeOther = host.registerSection(
			{ name: "other", order: 10, text: "OTHER", complete: true },
			{ scope: child },
		);
		expect(host.assemble({ scope: child }).complete?.text).toBe("OTHER");

		const revision = host.revision;
		expect(() => disposeShadow()).toThrow(/only one prompt section may be complete/);
		expect(host.revision).toBe(revision);
		expect(host.assemble({ scope: child }).complete?.text).toBe("OTHER");

		disposeOther();
		disposeShadow();
		expect(host.assemble({ scope: child }).complete?.text).toBe("ONLY");
	});
});

describe("prompts/host context", () => {
	it("dedupes identical text and only re-delivers changed content", () => {
		const host = new PromptHost();
		host.registerContext({ name: "goal", text: "GOAL", cacheScope: "turn" });
		expect(host.collectContext()).toMatchObject([{ name: "goal", text: "GOAL", cacheScope: "turn" }]);
		expect(host.collectContext()).toEqual([]);

		host.registerContext({ name: "goal", text: "NEW GOAL", cacheScope: "turn" }, { lane: "session" });
		expect(host.collectContext().map(message => message.text)).toEqual(["NEW GOAL"]);
	});

	it("dedupes the same text contributed under different names", () => {
		const host = new PromptHost();
		host.registerContext({ name: "a", text: "SAME" });
		host.registerContext({ name: "b", text: "SAME" });
		expect(host.collectContext().map(message => message.name)).toEqual(["a"]);
	});

	it("keeps a required context on every collection", () => {
		const host = new PromptHost();
		host.registerContext({ name: "mode", text: "PLAN", required: true });
		expect(host.collectContext().map(message => message.text)).toEqual(["PLAN"]);
		expect(host.collectContext().map(message => message.text)).toEqual(["PLAN"]);
	});

	it("filters by cache scope without marking filtered contexts delivered", () => {
		const host = new PromptHost();
		host.registerContext({ name: "turn", text: "TURN", cacheScope: "turn" });
		host.registerContext({ name: "request", text: "REQUEST", cacheScope: "request" });
		expect(host.collectContext({ cacheScope: "request" }).map(message => message.name)).toEqual(["request"]);
		expect(host.collectContext({ cacheScope: "turn" }).map(message => message.name)).toEqual(["turn"]);
	});

	it("rejects an unknown cache scope", () => {
		const host = new PromptHost();
		expect(() => host.registerContext({ name: "bad", text: "X", cacheScope: "forever" as never })).toThrow(
			/cacheScope/,
		);
	});
});

describe("prompts/host sections and variables", () => {
	it("interpolates strict variables and shadows a resolver", () => {
		const host = new PromptHost();
		host.registerVariable("name", () => "MusePi");
		host.registerSection({ name: "greet", order: 10, text: "hello {{ name }}" });
		expect(host.assemble().sections.map(section => section.text)).toEqual(["hello MusePi"]);

		const disposeShadow = host.registerVariable("name", () => "Other");
		expect(host.assemble().sections.map(section => section.text)).toEqual(["hello Other"]);
		disposeShadow();
		expect(host.assemble().sections.map(section => section.text)).toEqual(["hello MusePi"]);
	});

	it("fails loudly for unknown and unresolved variables", () => {
		const unknown = new PromptHost();
		unknown.registerSection({ name: "bad", order: 10, text: "{{ nobody }}" });
		expect(() => unknown.assemble()).toThrow(/unknown prompt variable: nobody/);

		const unresolved = new PromptHost();
		unresolved.registerVariable("empty", () => undefined);
		unresolved.registerSection({ name: "bad", order: 10, text: "{{ empty }}" });
		expect(() => unresolved.assemble()).toThrow(/unresolved prompt variable: empty/);
	});

	it("renders function text against the contribution context and skips undefined", () => {
		const host = new PromptHost();
		host.registerSection({
			name: "conditional",
			order: 10,
			text: context => (context.activeTools.includes("read") ? "READY" : undefined),
		});
		expect(host.assemble().sections).toEqual([]);
		expect(host.assemble({ activeTools: ["read"] }).sections.map(section => section.text)).toEqual(["READY"]);
	});
});

describe("prompts/host literal sections", () => {
	it("keeps {{...}} literal when interpolate is false", () => {
		const host = new PromptHost();
		host.registerSection({
			name: "agents",
			order: 10,
			interpolate: false,
			text: () => "user content with {{ nobody }} braces",
		});
		expect(host.assemble().sections.map(section => section.text)).toEqual(["user content with {{ nobody }} braces"]);
	});

	it("still interpolates function text strictly by default", () => {
		const host = new PromptHost();
		host.registerSection({ name: "bad", order: 10, text: () => "{{ nobody }}" });
		expect(() => host.assemble()).toThrow(/unknown prompt variable: nobody/);
	});
});

describe("prompts/host tools", () => {
	it("only emits a tool section while its tool or wire name is active", () => {
		const host = new PromptHost();
		host.registerTool({ tool: "read", text: context => `${context.tool}:${context.wireName}` });

		expect(host.assemble().sections).toEqual([]);
		const [section] = host.assemble({ activeTools: ["read"] }).sections;
		expect(section).toMatchObject({ name: "tool:read", order: PROMPT_ORDERS.tool, text: "read:read" });
	});

	it("resolves wire names and exposes the active set to the provider", () => {
		const host = new PromptHost();
		host.registerTool({
			tool: "bash",
			wireNames: ["shell"],
			text: context => `${context.wireName}|${context.activeTools.join(",")}`,
		});
		expect(host.assemble({ activeTools: ["shell"] }).sections[0]?.text).toBe("shell|shell");
	});

	it("lets a regular section show through while the tool is inactive", () => {
		const host = new PromptHost();
		host.registerSection({ name: "tool:read", order: 10, text: "FALLBACK" });
		host.registerTool({ tool: "read", text: "TOOL" });
		expect(host.assemble().sections.map(section => section.text)).toEqual(["FALLBACK"]);
		expect(host.assemble({ activeTools: ["read"] }).sections.map(section => section.text)).toEqual(["TOOL"]);
	});
});

describe("prompts/host cache scopes", () => {
	it("defaults sections to prefix and filters assembly by cache scope", () => {
		const host = new PromptHost();
		host.registerSection({ name: "stable", order: 10, text: "STABLE" });
		host.registerSection({ name: "volatile", order: 20, text: "VOLATILE", cacheScope: "request" });
		expect(host.assemble().sections.map(section => section.cacheScope)).toEqual(["prefix", "request"]);
		expect(host.assemble({ cacheScope: "prefix" }).sections.map(section => section.text)).toEqual(["STABLE"]);
	});
});

describe("prompts/host lifecycle", () => {
	it("bumps revision on structural changes only", () => {
		const host = new PromptHost();
		const disposeSection = host.registerSection({ name: "a", order: 10, text: "A" });
		expect(host.revision).toBe(1);
		host.registerContext({ name: "c", text: "C" });
		expect(host.revision).toBe(2);
		host.registerVariable("v", () => "V");
		expect(host.revision).toBe(3);
		host.registerTool({ tool: "read", text: "R" });
		expect(host.revision).toBe(4);

		host.assemble({ activeTools: ["read"] });
		host.collectContext();
		expect(host.revision).toBe(4);

		disposeSection();
		expect(host.revision).toBe(5);
		disposeSection();
		expect(host.revision).toBe(5);
	});

	it("releases every contribution of one owner at once", () => {
		const host = new PromptHost();
		host.registerSection({ name: "a", order: 10, text: "A" }, { owner: "ext:one" });
		host.registerContext({ name: "c", text: "C" }, { owner: "ext:one" });
		host.registerVariable("v", () => "V", { owner: "ext:one" });
		host.registerTool({ tool: "read", text: "R" }, { owner: "ext:one" });
		host.registerSection({ name: "keep", order: 11, text: "KEEP" }, { owner: "ext:two" });

		host.removeByOwner("ext:one");
		expect(host.revision).toBe(6);
		expect(host.assemble({ activeTools: ["read"] }).sections.map(section => section.text)).toEqual(["KEEP"]);
		expect(host.collectContext()).toEqual([]);

		host.removeByOwner("ext:one");
		expect(host.revision).toBe(6);
	});

	it("closes idempotently and refuses new registrations afterwards", () => {
		const host = new PromptHost();
		host.registerSection({ name: "a", order: 10, text: "A" });
		host.registerContext({ name: "c", text: "C" });
		const revision = host.revision;

		host.close();
		expect(host.closed).toBe(true);
		expect(host.revision).toBe(revision + 1);
		expect(host.assemble()).toEqual({ revision: revision + 1, sections: [], complete: null });
		expect(host.collectContext()).toEqual([]);

		host.close();
		expect(host.revision).toBe(revision + 1);
		expect(() => host.registerSection({ name: "b", order: 11, text: "B" })).toThrow(/closed/);
	});
});

describe("prompts/host scoped owner views", () => {
	it("records a registration only after the store accepts it", () => {
		const host = new PromptHost();
		host.registerSection({ name: "whole", order: 0, text: "ONLY", complete: true });
		const ledger: ScopedPromptHostLedger = { entries: [] };
		const scoped = scopePromptHostToOwner(host, "ext:scoped", ledger);

		// A conflicting complete section throws atomically; the failed input
		// must not linger in the ledger as a ghost registration.
		const revision = host.revision;
		expect(() => scoped.registerSection({ name: "other", order: 10, text: "OTHER", complete: true })).toThrow(
			PromptRegistryError,
		);
		expect(ledger.entries).toEqual([]);
		expect(host.revision).toBe(revision);

		// Replay never resurrects the failed registration.
		replayPromptHostLedger(host, "ext:scoped", ledger);
		expect(host.assemble().complete?.text).toBe("ONLY");
		expect(host.assemble().sections.map(section => section.text)).toEqual(["ONLY"]);

		// A later successful registration is recorded and replays cleanly.
		scoped.registerSection({ name: "part", order: 10, text: "PART" });
		expect(ledger.entries.map(entry => entry.kind)).toEqual(["section"]);
		replayPromptHostLedger(host, "ext:scoped", ledger);
		expect(host.assemble().sections.map(section => section.text)).toEqual(["ONLY", "PART"]);
	});
});

describe("prompts/host public contract", () => {
	it("keeps the default lane order stable", () => {
		expect(DEFAULT_PROMPT_LANES).toEqual(["core", "extension", "preset", "session"]);
	});
});
