/**
 * Collab domain — live-session sharing over @musepi/collab-proto. Host
 * lifecycle is local (mutates sharing state); status/QR are session-level so
 * remote guests can observe.
 */
import { Type } from "@sinclair/typebox";
import type { MethodEntry } from "../index";

export const collabStatus = {
	method: "collab.status",
	auth: "session",
	params: Type.Object({}),
	result: Type.Object({
		hosting: Type.Boolean(),
		guests: Type.Number(),
		link: Type.Optional(Type.String()),
		readOnly: Type.Optional(Type.Boolean()),
	}),
	impl: "CollabHost / guest state (runtime)",
} satisfies MethodEntry;

export const collabHost = {
	method: "collab.host",
	auth: "local",
	params: Type.Object({
		readOnly: Type.Optional(Type.Boolean({ default: false })),
		relayUrl: Type.Optional(Type.String()),
	}),
	result: Type.Object({
		link: Type.String(),
		qr: Type.Optional(Type.String({ description: "QR payload (scannable link)" })),
	}),
	impl: "CollabHost.start() + collab-qrcode (runtime)",
} satisfies MethodEntry;

export const collabStop = {
	method: "collab.stop",
	auth: "local",
	params: Type.Object({}),
	result: Type.Object({ ok: Type.Boolean() }),
	impl: "CollabHost.stop() (runtime)",
} satisfies MethodEntry;

export const collabMethods: MethodEntry[] = [collabStatus, collabHost, collabStop];
