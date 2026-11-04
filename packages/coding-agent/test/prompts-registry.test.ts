import { describe, expect, it } from "bun:test";
import { PROMPT_ORDERS, resolvePromptOrder } from "@musepi/pi-coding-agent/prompts/orders";
import { PromptRegistry, PromptRegistryError } from "@musepi/pi-coding-agent/prompts/registry";

// Named prompt registry: central sparse orders, function text, shadowing, one
// complete section, strict variables, revision.

describe("prompts/orders", () => {
	it("resolves named anchors to the composer slot numbers", () => {
		expect(resolvePromptOrder("core")).toBe(0);
		expect(resolvePromptOrder("injection")).toBe(25);
		expect(resolvePromptOrder("tool")).toBe(75);
		expect(resolvePromptOrder("safety")).toBe(100);
		expect(resolvePromptOrder("project")).toBe(200);
		expect(resolvePromptOrder("repoContext")).toBe(300);
		expect(resolvePromptOrder(150)).toBe(150);
	});

	it("keeps the sparse anchors strictly increasing", () => {
		const values = Object.values(PROMPT_ORDERS);
		expect(values).toEqual([...values].sort((a, b) => a - b));
		expect(new Set(values).size).toBe(values.length);
	});

	it("rejects unknown anchors and non-finite numeric orders", () => {
		expect(() => resolvePromptOrder("nope" as never)).toThrow(/unknown prompt order/);
		expect(() => resolvePromptOrder(Number.NaN)).toThrow(/finite/);
	});
});

describe("prompts/registry assemble", () => {
	it("an empty registry assembles nothing and stays at revision 0", () => {
		const registry = new PromptRegistry();
		expect(registry.assemble()).toEqual({ revision: 0, sections: [], complete: null });
		expect(registry.size).toBe(0);
	});

	it("orders sections by slot then name and accepts named anchors", () => {
		const registry = new PromptRegistry();
		registry.registerSection({ name: "b", order: "safety", text: "B" });
		registry.registerSection({ name: "a", order: "injection", text: "A" });
		registry.registerSection({ name: "z", order: "injection", text: "Z" });
		expect(registry.assemble().sections.map(section => [section.name, section.order, section.text])).toEqual([
			["a", 25, "A"],
			["z", 25, "Z"],
			["b", 100, "B"],
		]);
	});

	it("lets a later registration shadow the same name and restores the previous one on dispose", () => {
		const registry = new PromptRegistry();
		const disposeFirst = registry.registerSection({ name: "role", order: 10, text: "first" }, "mode:a");
		const disposeSecond = registry.registerSection({ name: "role", order: 5, text: "second" }, "ext:b");
		expect(registry.size).toBe(1);
		expect(registry.assemble().sections.map(section => section.text)).toEqual(["second"]);

		disposeSecond();
		expect(registry.assemble().sections.map(section => section.text)).toEqual(["first"]);

		disposeFirst();
		expect(registry.assemble().sections).toEqual([]);
	});

	it("evaluates function text per assembly and skips undefined results", () => {
		const registry = new PromptRegistry();
		registry.registerSection({
			name: "conditional",
			order: "injection",
			text: context => (context.design === true ? "DESIGN" : undefined),
		});
		expect(registry.assemble({}).sections).toEqual([]);
		expect(registry.assemble({ design: true }).sections.map(section => section.text)).toEqual(["DESIGN"]);
	});

	it("keeps empty string sections as real output", () => {
		const registry = new PromptRegistry();
		registry.registerSection({ name: "blank", order: 10, text: "" });
		expect(registry.assemble().sections.map(section => section.text)).toEqual([""]);
	});

	it("interpolates registered variables and fails loudly on unknown ones", () => {
		const registry = new PromptRegistry();
		registry.registerVariable("name", () => "MusePi");
		registry.registerVariable("count", () => 2);
		registry.registerSection({ name: "ok", order: 10, text: "hello {{ name }} ({{count}})" });
		expect(registry.assemble().sections.map(section => section.text)).toEqual(["hello MusePi (2)"]);

		registry.registerSection({ name: "bad", order: 20, text: "hello {{ missing }}" });
		expect(() => registry.assemble()).toThrow(PromptRegistryError);
		expect(() => registry.assemble()).toThrow(/unknown prompt variable: missing/);
	});

	it("fails when a registered variable resolves to undefined", () => {
		const registry = new PromptRegistry();
		registry.registerVariable("absent", () => undefined);
		registry.registerSection({ name: "s", order: 10, text: "{{ absent }}" });
		expect(() => registry.assemble()).toThrow(/unresolved prompt variable: absent/);
	});

	it("resolves variables at assembly time and restores a shadowed resolver", () => {
		let value = "one";
		const registry = new PromptRegistry();
		registry.registerVariable("n", () => value);
		const disposeShadow = registry.registerVariable("n", () => "two");
		registry.registerSection({ name: "s", order: 10, text: "{{n}}" });
		expect(registry.assemble().sections[0]?.text).toBe("two");

		disposeShadow();
		expect(registry.assemble().sections[0]?.text).toBe("one");
		value = "changed";
		expect(registry.assemble().sections[0]?.text).toBe("changed");
	});

	it("hands function text the strict variable resolver", () => {
		const registry = new PromptRegistry();
		registry.registerVariable("mode", () => "design");
		registry.registerSection({ name: "s", order: 10, text: context => `active:${context.variable("mode")}` });
		expect(registry.assemble().sections.map(section => section.text)).toEqual(["active:design"]);
	});
});

describe("prompts/registry complete", () => {
	it("accepts one complete section and rejects a second distinct one", () => {
		const registry = new PromptRegistry();
		registry.registerSection({ name: "whole", order: "core", text: "ONLY", complete: true });
		expect(registry.assemble().complete?.text).toBe("ONLY");
		const before = registry.assemble();

		expect(() => registry.registerSection({ name: "other", order: "injection", text: "X", complete: true })).toThrow(
			PromptRegistryError,
		);
		expect(() => registry.registerSection({ name: "other", order: "injection", text: "X", complete: true })).toThrow(
			/complete/,
		);

		// Rejected registration must not mutate the registry or bump revision.
		expect(registry.revision).toBe(before.revision);
		expect(registry.assemble()).toEqual(before);
		expect(registry.size).toBe(1);
	});

	it("releases the complete slot when the complete section is disposed or shadowed", () => {
		const registry = new PromptRegistry();
		const disposeWhole = registry.registerSection({ name: "whole", order: 0, text: "ONLY", complete: true });
		disposeWhole();
		registry.registerSection({ name: "other", order: 10, text: "OTHER", complete: true });
		expect(registry.assemble().complete?.text).toBe("OTHER");

		registry.registerSection({ name: "other", order: 10, text: "PARTIAL" });
		expect(registry.assemble().complete).toBeNull();
		registry.registerSection({ name: "third", order: 20, text: "THIRD", complete: true });
		expect(registry.assemble().complete?.text).toBe("THIRD");
	});

	it("rejects a disposer that would reveal a second complete section, atomically", () => {
		const registry = new PromptRegistry();
		registry.registerSection({ name: "whole", order: 0, text: "ONLY", complete: true });
		const disposeShadow = registry.registerSection({ name: "whole", order: 0, text: "PARTIAL" });
		const disposeOther = registry.registerSection({ name: "other", order: 10, text: "OTHER", complete: true });
		expect(registry.assemble().complete?.text).toBe("OTHER");
		const revision = registry.revision;

		expect(() => disposeShadow()).toThrow(/only one prompt section may be complete/);
		expect(registry.revision).toBe(revision);
		expect(registry.assemble().complete?.text).toBe("OTHER");

		// The rejected disposer stays unspent; once the conflict is gone it works.
		disposeOther();
		disposeShadow();
		expect(registry.assemble().complete?.text).toBe("ONLY");
	});

	it("rejects a source removal that would reveal a second complete section, atomically", () => {
		const registry = new PromptRegistry();
		registry.registerSection({ name: "whole", order: 0, text: "ONLY", complete: true }, "mode:a");
		registry.registerSection({ name: "whole", order: 0, text: "PARTIAL" }, "ext:shadow");
		registry.registerSection({ name: "other", order: 10, text: "OTHER", complete: true }, "mode:b");
		const revision = registry.revision;

		expect(() => registry.removeBySource("ext:shadow")).toThrow(/only one prompt section may be complete/);
		expect(registry.revision).toBe(revision);
		expect(registry.assemble().complete?.text).toBe("OTHER");

		registry.removeBySource("mode:b");
		expect(registry.assemble().complete).toBeNull();
		registry.removeBySource("ext:shadow");
		expect(registry.assemble().complete?.text).toBe("ONLY");
	});
});

describe("prompts/registry lifecycle", () => {
	it("increments revision on every structural mutation and never on assemble", () => {
		const registry = new PromptRegistry();
		expect(registry.revision).toBe(0);

		const dispose = registry.registerSection({ name: "a", order: 10, text: "A" }, "ext:a");
		expect(registry.revision).toBe(1);

		const disposeVariable = registry.registerVariable("v", () => "V");
		expect(registry.revision).toBe(2);

		expect(registry.assemble().revision).toBe(2);
		expect(registry.assemble().revision).toBe(2);

		dispose();
		expect(registry.revision).toBe(3);
		dispose();
		expect(registry.revision).toBe(3);

		registry.removeBySource("missing");
		expect(registry.revision).toBe(3);

		registry.registerSection({ name: "b", order: 11, text: "B" }, "ext:b");
		registry.removeBySource("ext:b");
		expect(registry.revision).toBe(5);

		disposeVariable();
		expect(registry.revision).toBe(6);

		registry.clear();
		expect(registry.revision).toBe(6);
		expect(registry.assemble().revision).toBe(6);
	});

	it("removes every section contributed by one source", () => {
		const registry = new PromptRegistry();
		registry.registerSection({ name: "a", order: 10, text: "A" }, "mode:design");
		registry.registerSection({ name: "b", order: 11, text: "B" }, "mode:design");
		registry.registerSection({ name: "c", order: 12, text: "C" }, "ext:ui");
		registry.removeBySource("mode:design");
		expect(registry.assemble().sections.map(section => [section.name, section.source])).toEqual([["c", "ext:ui"]]);
	});
});
