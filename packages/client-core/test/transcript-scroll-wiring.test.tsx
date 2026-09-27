import { describe, expect, spyOn, test } from "bun:test";
import type { SessionEntry } from "@musepi/pi-wire";
import * as reactVirtual from "@tanstack/react-virtual";
import { renderToStaticMarkup } from "react-dom/server";
import "./transcript-dom-shim";
import * as scrollAnchor from "../src/components/transcript/scroll-anchor";
import { Transcript } from "../src/components/transcript/Transcript";

function userEntry(timestamp: number): SessionEntry {
	return {
		type: "message",
		id: `user-${timestamp}`,
		parentId: null,
		timestamp: "2026-07-09T00:00:00Z",
		message: { role: "user", content: "do it", timestamp },
	};
}

function assistantEntry(timestamp: number): SessionEntry {
	return {
		type: "message",
		id: `assistant-${timestamp}`,
		parentId: null,
		timestamp: "2026-07-09T00:00:00Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "hello" }],
			model: "test/model",
			usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0 } },
			stopReason: "stop",
			timestamp,
		},
	};
}

type GateFactory = typeof scrollAnchor.createShouldAdjustForItemSizeChange;
type GateFactoryDeps = Parameters<GateFactory>[0];
type GateFn = (item: { end: number }) => boolean;
type Virtualizer = reactVirtual.Virtualizer<HTMLElement, Element>;

describe("transcript scroll-compensation wiring", () => {
	test("the virtualizer's size-change predicate IS the anchor-machine gate (no blanket disable)", () => {
		// Contract: tanstack consults `shouldAdjustScrollPositionOnItemSizeChange`
		// per measured size change and writes the delta into scrollTop when it
		// returns true — that is how an above-viewport fold animation keeps the
		// reading position anchored. The transcript must install the
		// scroll-anchor gate here; a regression to `() => false` (the old
		// blanket disable behind the collapsed-state upscroll jitter) leaves
		// the factory unwired and fails this identity assertion.
		const originalUseVirtualizer = reactVirtual.useVirtualizer;
		// Ref objects (not bare lets): the assignments happen inside spied
		// closures, which TS control-flow analysis does not track — a bare
		// `let` narrows to its initializer here and the property read below
		// would type as never.
		const installedRef: { current: Virtualizer | null } = { current: null };
		const hookSpy = spyOn(reactVirtual, "useVirtualizer");
		hookSpy.mockImplementation(((options: unknown) => {
			const virtualizer = (originalUseVirtualizer as (o: unknown) => Virtualizer)(options);
			installedRef.current = virtualizer;
			return virtualizer;
		}) as typeof reactVirtual.useVirtualizer);

		const originalFactory = scrollAnchor.createShouldAdjustForItemSizeChange;
		const factoryResultRef: { current: GateFn | null } = { current: null };
		const factorySpy = spyOn(scrollAnchor, "createShouldAdjustForItemSizeChange");
		factorySpy.mockImplementation(((deps: GateFactoryDeps) => {
			const gate = originalFactory(deps);
			factoryResultRef.current = gate;
			return gate;
		}) as GateFactory);

		try {
			renderToStaticMarkup(
				<Transcript
					entries={[userEntry(1), assistantEntry(2)]}
					stream={null}
					streamDone={true}
					activeTools={new Map()}
					working={false}
				/>,
			);
		} finally {
			hookSpy.mockRestore();
			factorySpy.mockRestore();
		}

		expect(factoryResultRef.current).not.toBeNull();
		const installedPredicate = installedRef.current?.shouldAdjustScrollPositionOnItemSizeChange;
		expect(installedPredicate).toBe(factoryResultRef.current as GateFn | undefined);
	});
});
