/**
 * The focus-mode composer morph.
 *
 * ⌘⇧E grows the composer from a compact box to a full-height editor. It is
 * an WAAPI animation (the `transition: height` CSS path was abandoned after
 * it double-drove the same property every frame), so CSS media rules do NOT
 * apply to it — reduced motion and cancellation have to be handled in JS.
 *
 * These are source-level contract tests on purpose: the morph needs a real
 * layout engine to run (happy-dom has none), but the three things that
 * regressed can all be checked statically, and each has a mutation that
 * makes the test fail:
 *   1. the easing comes from springEasing(), not a hardcoded bezier;
 *   2. reduced motion returns BEFORE the animation is started;
 *   3. an interrupted morph is cancelled, not just version-guarded.
 */
import "./happy-dom-shim";
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { springEasing } from "@musepi/client-core";

const source = readFileSync(resolve(import.meta.dir, "../src/components/ChatView.tsx"), "utf8");

describe("focus-mode composer morph", () => {
	it("samples its easing from the shared spring resource, not a hand-tuned bezier", () => {
		expect(source).toContain("springEasing(");
		expect(source).toContain("COMPOSER_MORPH_EASING");
		// The morph's WAAPI call must use the spring curve. (Another
		// animation in this file legitimately uses a bezier — the session
		// info seat — so check the morph block specifically.)
		const morph = source.slice(
			source.indexOf("const anim = el.animate("),
			source.indexOf("wrapAnimRef.current = anim;") + 40,
		);
		expect(morph).toContain("easing: COMPOSER_MORPH_EASING");
		expect(morph).not.toContain("cubic-bezier");
	});

	it("the spring overshoots and lands exactly on its target", () => {
		const curve = springEasing({ visualDuration: 0.28, bounce: 0.06 }, 16, 320);
		const stops = curve
			.slice("linear(".length, -1)
			.split(",")
			.map(stop => Number.parseFloat(stop.trim().split(/\s+/)[0] ?? ""));
		expect(stops[0]).toBe(0);
		expect(stops.at(-1)).toBe(1);
		// Overshoot: the surface sails past its target and comes back.
		expect(Math.max(...stops)).toBeGreaterThan(1);
		expect(Math.max(...stops)).toBeLessThanOrEqual(1.07);
	});

	it("checks reduced motion BEFORE pinning and starting the animation", () => {
		// The FIRST occurrence is the helper definition; the call site is the
		// one guarded by `if (...)`.
		const first = source.indexOf("composerMotionOff()");
		const check = source.indexOf("composerMotionOff()", first + 1);
		const pin = source.indexOf("el.classList.add(\"gui-composer-wrap--morphing\")");
		const animate = source.indexOf("el.animate(");
		expect(check).toBeGreaterThan(first);
		expect(pin).toBeGreaterThan(check);
		expect(animate).toBeGreaterThan(check);
		// The early return must actually bail out, not just set a flag.
		expect(source.slice(check, check + 400)).toContain("return;");
	});

	it("cancels the previous animation on interrupt, not just its release", () => {
		expect(source).toContain("wrapAnimRef.current?.cancel()");
		// The cleanup must cancel too — an unmount must not leave an
		// animation writing to a detached node.
		const cleanup = source.slice(source.indexOf("return () => {", source.indexOf("wrapAnimRef.current = anim")));
		expect(cleanup).toContain("anim.cancel()");
	});
});
