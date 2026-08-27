import { createRoot } from "react-dom/client";
import * as React from "react";
import { App } from "./app";
import "./styles/tokens.css";
import "./styles/base.css";
import "./i18n";

// Desktop web entry (index.html). The Capacitor shell redirects to mobile.html
// (see the inline script in index.html), so this bundle never touches
// Capacitor plugins — mobile-only logic lives in ./mobile.tsx.

// Slot-host contract: compiled extension components (daemon
// extension-artifact-compiler) reference React through window.MusePiReact so
// they bind to the HOST's react instance. The desktop-web bundle IS a React
// host (it renders the session), so it exposes its instance the same way the
// GUI's slot-host does. The compat slot host (injected by `musepi serve`)
// then blob-imports extension components against this instance.
(window as unknown as { MusePiReact?: unknown }).MusePiReact = React;

// The compat slot-host registry (dsh-desktop plugin parity): the injected
// serve script calls register() for each compiled extension component; the
// bundle's Transcript / CompatSlotHost read get()/getForSlot() to render
// them. Initialized here so the page is the host even before the injection
// script runs; guests in a plain browser have no registry (nothing is ever
// registered) and render the built-ins.
if (!(globalThis as { MusePiCompatHost?: unknown }).MusePiCompatHost) {
	const bySlot = new Map<string, Array<{ entryKinds: string[]; Component: unknown; extensionId: string }>>();
	(globalThis as { MusePiCompatHost?: unknown }).MusePiCompatHost = {
		register(slot: string, entryKinds: string[], Component: unknown, extensionId: string): void {
			let list = bySlot.get(slot);
			if (!list) {
				list = [];
				bySlot.set(slot, list);
			}
			list.push({ entryKinds, Component, extensionId });
		},
		getForSlot(slot: string): unknown[] {
			return (bySlot.get(slot) ?? []).map(({ Component, extensionId, entryKinds }) => ({
				Component,
				extensionId,
				entryKinds,
			}));
		},
		get(slot: string, kind: string): unknown {
			const hit = (bySlot.get(slot) ?? []).find(
				item => item.entryKinds.includes(kind) || item.entryKinds.length === 0,
			);
			return hit ? { Component: hit.Component, extensionId: hit.extensionId } : undefined;
		},
	};
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(<App />);
