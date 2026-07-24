// MusePi: Container damage-tracking tests — fingerprinted children skip
// re-renders while their state and width are unchanged; everything else
// behaves exactly as before.
import assert from "node:assert";
import { describe, it } from "node:test";
import { Container } from "../src/tui.ts";

function makeTracked(lines: string[], fp: () => unknown) {
	const comp = {
		renders: 0,
		fingerprint: fp,
		invalidate() {},
		render(_width: number) {
			comp.renders++;
			return lines;
		},
	};
	return comp;
}

describe("Container damage tracking (MusePi)", () => {
	it("re-renders children without fingerprint every frame", () => {
		const plain = {
			renders: 0,
			invalidate() {},
			render: () => {
				plain.renders++;
				return ["x"];
			},
		};
		const c = new Container();
		c.addChild(plain as any);
		c.render(80);
		c.render(80);
		assert.strictEqual(plain.renders, 2);
	});

	it("skips re-render while fingerprint + width are unchanged", () => {
		const a = makeTracked(["A"], () => "fa");
		const b = makeTracked(["B1", "B2"], () => "fb");
		const c = new Container();
		c.addChild(a as any);
		c.addChild(b as any);
		assert.deepStrictEqual(c.render(80), ["A", "B1", "B2"]);
		c.render(80);
		assert.strictEqual(a.renders, 1);
		assert.strictEqual(b.renders, 1);
	});

	it("re-renders only the child whose fingerprint changed", () => {
		let fpA: unknown = "fa";
		const a = makeTracked(["A"], () => fpA);
		const b = makeTracked(["B"], () => "fb");
		const c = new Container();
		c.addChild(a as any);
		c.addChild(b as any);
		c.render(80);
		fpA = "fa2";
		c.render(80);
		assert.strictEqual(a.renders, 2);
		assert.strictEqual(b.renders, 1);
	});

	it("re-renders on width change even with a stable fingerprint", () => {
		const a = makeTracked(["A"], () => "fa");
		const c = new Container();
		c.addChild(a as any);
		c.render(80);
		c.render(40);
		assert.strictEqual(a.renders, 2);
	});

	it("invalidate() drops the damage cache", () => {
		const a = makeTracked(["A"], () => "fa");
		const c = new Container();
		c.addChild(a as any);
		c.render(80);
		c.invalidate();
		c.render(80);
		assert.strictEqual(a.renders, 2);
	});

	it("removeChild/clear evict cache entries", () => {
		const a = makeTracked(["A"], () => "fa");
		const c = new Container();
		c.addChild(a as any);
		c.render(80);
		c.removeChild(a as any);
		c.addChild(a as any);
		c.render(80);
		assert.strictEqual(a.renders, 2);
	});
});
