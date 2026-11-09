import { ToolError } from "../tool-errors";
import type { Observation, ScreenshotResult } from "./tab-protocol";

const SNAPSHOT_TTL_MS = 60_000;
let sequence = 0;

export interface BrowserElementsSnapshot extends Observation {
	snapshotId: string;
	capturedAt: string;
}

export interface BrowserVisualSnapshot {
	snapshotId: string;
	url: string;
	title: string;
	viewport: Observation["viewport"];
	image: ScreenshotResult;
	capturedAt: string;
}

export interface BrowserSnapshotElement {
	ref: string;
	role: string;
	name?: string;
	value?: string | number;
	description?: string;
	keyshortcuts?: string;
	states: string[];
}

export interface BrowserElementsPage {
	snapshotId: string;
	scope: "viewport" | "document";
	url: string;
	title?: string;
	elements: BrowserSnapshotElement[];
	returned: number;
	total: number;
	truncated: boolean;
	scanTruncated: boolean;
	nextCursor?: string;
	capturedAt: string;
}

export interface ElementPageOptions {
	scope?: "viewport" | "document";
	limit?: number;
	maxChars?: number;
	cursor?: string;
	role?: string;
	text?: string;
}

interface ElementRecord {
	tabName: string;
	expiresAt: number;
	snapshot: BrowserElementsSnapshot;
}

interface VisualRecord {
	tabName: string;
	expiresAt: number;
	snapshot: BrowserVisualSnapshot;
}

const elementRecords = new Map<string, ElementRecord>();
const visualRecords = new Map<string, VisualRecord>();

export function createElementSnapshot(
	tabName: string,
	observation: Observation,
	now = Date.now(),
): BrowserElementsSnapshot {
	const snapshot = { ...observation, snapshotId: `elements-${++sequence}`, capturedAt: new Date(now).toISOString() };
	elementRecords.set(snapshot.snapshotId, { tabName, expiresAt: now + SNAPSHOT_TTL_MS, snapshot });
	return snapshot;
}

export function readElementSnapshot(tabName: string, snapshotId: string, now = Date.now()): BrowserElementsSnapshot {
	const record = elementRecords.get(snapshotId);
	if (!record) throw new ToolError(`Element snapshot not found: ${snapshotId}`);
	if (record.tabName !== tabName) throw new ToolError(`Element snapshot ${snapshotId} belongs to a different tab`);
	if (now > record.expiresAt) {
		elementRecords.delete(snapshotId);
		throw new ToolError(`Element snapshot expired: ${snapshotId}`);
	}
	return record.snapshot;
}

export function createVisualSnapshot(
	tabName: string,
	input: Omit<BrowserVisualSnapshot, "snapshotId">,
	now = Date.now(),
): BrowserVisualSnapshot {
	const snapshot = { ...input, snapshotId: `visual-${++sequence}` };
	visualRecords.set(snapshot.snapshotId, { tabName, expiresAt: now + SNAPSHOT_TTL_MS, snapshot });
	return snapshot;
}

export function readVisualSnapshot(tabName: string, snapshotId: string, now = Date.now()): BrowserVisualSnapshot {
	const record = visualRecords.get(snapshotId);
	if (!record) throw new ToolError(`Visual snapshot not found: ${snapshotId}`);
	if (record.tabName !== tabName) throw new ToolError(`Visual snapshot ${snapshotId} belongs to a different tab`);
	if (now > record.expiresAt) {
		visualRecords.delete(snapshotId);
		throw new ToolError(`Visual snapshot expired: ${snapshotId}`);
	}
	return record.snapshot;
}

export function paginateElementSnapshot(
	snapshot: BrowserElementsSnapshot,
	options: ElementPageOptions = {},
): BrowserElementsPage {
	const limit = options.limit ?? 100;
	if (!Number.isInteger(limit) || limit < 1 || limit > 500)
		throw new ToolError("Element limit must be between 1 and 500");
	const maxChars = options.maxChars ?? 8000;
	if (!Number.isInteger(maxChars) || maxChars < 2048 || maxChars > 24000) {
		throw new ToolError("maxChars must be an integer between 2048 and 24000");
	}
	const role = options.role?.trim().toLowerCase();
	const text = options.text?.trim().toLowerCase();
	const filtered = snapshot.elements.filter(element => {
		if (role && element.role.toLowerCase() !== role) return false;
		if (text && !`${element.name ?? ""} ${element.value ?? ""}`.toLowerCase().includes(text)) return false;
		return true;
	});
	let cursor = 0;
	if (options.cursor !== undefined) {
		if (!/^\d+$/.test(options.cursor))
			throw new ToolError(`Invalid element cursor ${JSON.stringify(options.cursor)}`);
		cursor = Number(options.cursor);
		if (cursor >= filtered.length) throw new ToolError(`Element cursor is outside the snapshot: ${options.cursor}`);
	}
	const elements: BrowserSnapshotElement[] = [];
	let chars = 0;
	let nextCursor: string | undefined;
	for (let index = cursor; index < filtered.length; index++) {
		if (elements.length >= limit) {
			nextCursor = String(index);
			break;
		}
		const element = filtered[index]!;
		const projected: BrowserSnapshotElement = {
			ref: `e${element.id}`,
			role: element.role,
			...(element.name !== undefined ? { name: element.name.slice(0, Math.max(128, maxChars / 2)) } : {}),
			...(element.value !== undefined ? { value: element.value } : {}),
			...(element.description !== undefined ? { description: element.description.slice(0, 512) } : {}),
			...(element.keyshortcuts !== undefined ? { keyshortcuts: element.keyshortcuts } : {}),
			states: element.states.slice(0, 16),
		};
		const size = JSON.stringify(projected).length + 1;
		if (elements.length > 0 && chars + size > maxChars) {
			nextCursor = String(index);
			break;
		}
		elements.push(projected);
		chars += size;
	}
	return {
		snapshotId: snapshot.snapshotId,
		scope: options.scope ?? "viewport",
		url: snapshot.url,
		...(snapshot.title ? { title: snapshot.title } : {}),
		elements,
		returned: elements.length,
		total: filtered.length,
		truncated: nextCursor !== undefined,
		scanTruncated: false,
		...(nextCursor !== undefined ? { nextCursor } : {}),
		capturedAt: snapshot.capturedAt,
	};
}

export function visualPointToCss(
	snapshot: BrowserVisualSnapshot,
	point: { x: number; y: number },
): { x: number; y: number } {
	if (
		!Number.isFinite(point.x) ||
		!Number.isFinite(point.y) ||
		point.x < 0 ||
		point.y < 0 ||
		point.x > snapshot.image.width ||
		point.y > snapshot.image.height
	) {
		throw new ToolError(`Visual coordinate is outside snapshot ${snapshot.snapshotId}`);
	}
	return {
		x: (point.x * snapshot.viewport.width) / snapshot.image.width,
		y: (point.y * snapshot.viewport.height) / snapshot.image.height,
	};
}
