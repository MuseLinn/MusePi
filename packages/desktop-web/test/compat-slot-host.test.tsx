import { afterEach, describe, expect, it } from "bun:test";
import type { ComponentType, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CompatSlotHost } from "../src/lib/compat-slot-host";
import type { MusePiCompatHost } from "../src/components/transcript/Transcript";

/** Compat slot host (dsh-desktop plugin parity, extended mode): the desktop
 *  web bundle reads window.MusePiCompatHost (populated by the serve-injected
 *  script) and renders registered components per slot. Guests with no
 *  registry render nothing. */
describe("CompatSlotHost (extended-mode slot consumption)", () => {
	const original = (globalThis as { MusePiCompatHost?: MusePiCompatHost }).MusePiCompatHost;

	afterEach(() => {
		if (original === undefined) delete (globalThis as { MusePiCompatHost?: MusePiCompatHost }).MusePiCompatHost;
		else (globalThis as { MusePiCompatHost?: MusePiCompatHost }).MusePiCompatHost = original;
	});

	function seedRegistry(slot: string, extensionId: string): void {
		const bySlot = new Map<string, Array<{ entryKinds: string[]; Component: unknown; extensionId: string }>>();
		const Comp = ((): ComponentType<Record<string, unknown>> => function FakeExt(): ReactNode {
			return <span data-ext={extensionId} />;
		})();
		bySlot.set(slot, [{ entryKinds: [], Component: Comp, extensionId }]);
		(globalThis as { MusePiCompatHost?: MusePiCompatHost }).MusePiCompatHost = {
			register(slot_: string, entryKinds: string[], Component: unknown, extensionId_: string): void {
				let list = bySlot.get(slot_);
				if (!list) {
					list = [];
					bySlot.set(slot_, list);
				}
				list.push({ entryKinds, Component, extensionId: extensionId_ });
			},
			getForSlot(slot_: string): unknown[] {
				return (bySlot.get(slot_) ?? []).map(({ Component, extensionId, entryKinds }) => ({
					Component,
					extensionId,
					entryKinds,
				}));
			},
			get(slot_: string, kind: string): unknown {
				const hit = (bySlot.get(slot_) ?? []).find(
					item => item.entryKinds.includes(kind) || item.entryKinds.length === 0,
				);
				return hit ? { Component: hit.Component, extensionId: hit.extensionId } : undefined;
			},
		} as unknown as MusePiCompatHost;
	}

	it("renders registered components for a slot (composer.dock / statusbar)", () => {
		seedRegistry("statusbar", "ext-a");
		const html = renderToStaticMarkup(<CompatSlotHost slot="statusbar" />);
		expect(html).toContain('data-ext="ext-a"');
		expect(html).toContain('data-compat-slot="statusbar"');
	});

	it("renders nothing when the registry has no components for the slot", () => {
		seedRegistry("composer.dock", "ext-a");
		const html = renderToStaticMarkup(<CompatSlotHost slot="statusbar" />);
		expect(html).toBe("");
	});

	it("renders nothing when there is no registry at all (plain browser guest)", () => {
		delete (globalThis as { MusePiCompatHost?: MusePiCompatHost }).MusePiCompatHost;
		const html = renderToStaticMarkup(<CompatSlotHost slot="statusbar" />);
		expect(html).toBe("");
	});
});
