import { afterEach, describe, expect, test } from "bun:test";
import {
	declareCoreSeats,
	declareSeats,
	injectSeat,
	isSeatDeclared,
	onSeatChange,
	resetSeats,
	seatOwnerOf,
} from "@musepi/pi-coding-agent/extensibility/extensions/seat-lifecycle";

afterEach(() => resetSeats());

describe("seat declarations", () => {
	test("a seat is live only while its owner is declared", () => {
		expect(isSeatDeclared("conversation.composer.dock")).toBe(false);
		const release = declareSeats("dock", ["conversation.composer.dock"]);
		expect(isSeatDeclared("conversation.composer.dock")).toBe(true);
		expect(seatOwnerOf("conversation.composer.dock")).toBe("dock");
		release();
		expect(isSeatDeclared("conversation.composer.dock")).toBe(false);
	});

	test("two components cannot own one seat", () => {
		declareSeats("first", ["settings.section"]);
		expect(() => declareSeats("second", ["settings.section"])).toThrow(/already declared by first/);
		// The failed declaration rolled back none of the first owner's seats.
		expect(seatOwnerOf("settings.section")).toBe("first");
	});

	test("a failed multi-seat declaration releases the seats it already claimed", () => {
		declareSeats("first", ["settings.section"]);
		expect(() => declareSeats("second", ["settings.general.item", "settings.section"])).toThrow();
		expect(isSeatDeclared("settings.general.item")).toBe(false);
	});

	test("core seats are live without an owner component", () => {
		const release = declareCoreSeats(["shell.overlay"]);
		expect(isSeatDeclared("shell.overlay")).toBe(true);
		expect(seatOwnerOf("shell.overlay")).toBeNull();
		release();
		expect(isSeatDeclared("shell.overlay")).toBe(false);
	});

	test("a listener learns about every liveness change", () => {
		const seen: string[] = [];
		const off = onSeatChange(slot => seen.push(slot));
		const release = declareSeats("dock", ["conversation.composer.dock"]);
		release();
		off();
		expect(seen.filter(slot => slot === "conversation.composer.dock")).toHaveLength(2);
	});
});

describe("inject: a contribution rides its seat", () => {
	test("runs immediately when the seat is already live", () => {
		declareSeats("dock", ["conversation.composer.dock"]);
		let runs = 0;
		const stop = injectSeat("conversation.composer.dock", () => {
			runs += 1;
			return () => undefined;
		});
		expect(runs).toBe(1);
		stop();
	});

	test("waits for the declaration, then runs exactly once", () => {
		let runs = 0;
		const stop = injectSeat("conversation.composer.dock", () => {
			runs += 1;
			return () => undefined;
		});
		expect(runs).toBe(0);
		const release = declareSeats("dock", ["conversation.composer.dock"]);
		expect(runs).toBe(1);
		release();
		stop();
	});

	test("collapses with the owner and runs again when the owner returns", () => {
		const disposals: number[] = [];
		let runs = 0;
		injectSeat("conversation.composer.dock", () => {
			runs += 1;
			const id = runs;
			return () => disposals.push(id);
		});
		const first = declareSeats("dock-a", ["conversation.composer.dock"]);
		expect(runs).toBe(1);
		first();
		expect(disposals).toEqual([1]);
		const second = declareSeats("dock-b", ["conversation.composer.dock"]);
		expect(runs).toBe(2);
		second();
		expect(disposals).toEqual([1, 2]);
	});

	test("a stopped ride does not come back when the seat is redeclared", () => {
		let runs = 0;
		const stop = injectSeat("conversation.composer.dock", () => {
			runs += 1;
			return () => undefined;
		});
		const release = declareSeats("dock", ["conversation.composer.dock"]);
		expect(runs).toBe(1);
		stop();
		release();
		declareSeats("dock", ["conversation.composer.dock"]);
		expect(runs).toBe(1);
	});
});
