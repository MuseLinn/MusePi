import { describe, expect, test } from "bun:test";
import { EXTENSION_SLOT_DECLARATION } from "../src/extension-slots";
import { CORE_SEATS, SLOT_CONTRACTS, SLOT_PREFIX_CONTRACTS } from "../src/slot-contracts";

describe("slot contracts", () => {
	test("every declared exact slot has exactly one contract", () => {
		expect(Object.keys(SLOT_CONTRACTS).sort()).toEqual(Object.keys(EXTENSION_SLOT_DECLARATION.exact).sort());
	});

	test("every declared prefix has exactly one contract", () => {
		expect(SLOT_PREFIX_CONTRACTS.map(contract => contract.prefix).sort()).toEqual(
			[...EXTENSION_SLOT_DECLARATION.prefixes].sort(),
		);
	});

	test("a contract names how the seat is declared and what registering replaces", () => {
		for (const [name, contract] of Object.entries(SLOT_CONTRACTS)) {
			expect(contract.declaredBy.length, name).toBeGreaterThan(0);
			expect(contract.summary.length, name).toBeGreaterThan(0);
			expect(["shadows-shipped-ui", "additive"], name).toContain(contract.replaceRisk);
			expect(
				contract.registerOptions.some(option => option.name === "moduleUrl"),
				name,
			).toBe(true);
		}
	});

	test("every contract states who declares it and when it disappears", () => {
		for (const [name, contract] of Object.entries(SLOT_CONTRACTS)) {
			expect(["core", "component"], name).toContain(contract.lifetime);
		}
	});

	test("the core seat list is exactly the contracts that outlive their renderer", () => {
		const declaredCore = Object.entries(SLOT_CONTRACTS)
			.filter(([, contract]) => contract.lifetime === "core")
			.map(([name]) => name);
		expect([...CORE_SEATS].sort()).toEqual(declaredCore.sort());
		// Root-scoped seats are the shell's; a session-scoped seat belongs to the
		// component that renders it inside that session.
		for (const [name, contract] of Object.entries(SLOT_CONTRACTS)) {
			if (contract.lifetime === "core") expect(contract.scope, name).toBe("root");
		}
	});

	test("a settings page requires its nav identity", () => {
		const contract = SLOT_CONTRACTS["settings.section"];
		expect(contract.registerOptions.find(option => option.name === "id")?.requirement).toBe("required");
		expect(contract.ownerProps).toContain("settingsSection");
	});

	test("a chat-node seat requires the kinds it dispatches", () => {
		const contract = SLOT_CONTRACTS["conversation.chat.node"];
		expect(contract.registerOptions.find(option => option.name === "entryKinds")?.requirement).toBe("required");
	});
});
