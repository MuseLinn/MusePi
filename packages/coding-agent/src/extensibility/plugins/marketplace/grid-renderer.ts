/**
 * Marketplace grid renderer.
 *
 * Renders a list of `MarketplacePluginEntry` as a compact grid for the TUI
 * `/marketplace discover` command. Layout:
 *
 *   ┌─ Available plugins (12) ─────────────────────────────────────┐
 *   │ 🐙 github-mcp@1.2.0                                          │
 *   │   GitHub MCP server — issues, PRs, Actions                   │
 *   │ 📝 notion-mcp@0.9.0                                          │
 *   │   Notion MCP server — pages, databases, blocks               │
 *   │ ⚡ webhook-runner                                            │
 *   │   Trigger webhooks from slash commands                       │
 *   └───────────────────────────────────────────────────────────────┘
 *
 * Columns switch to two-up when the caller requests a wider terminal. Below
 * a narrow threshold the renderer falls back to a single-column compact list
 * so the panel still reads correctly on a phone-sized TUI.
 *
 * The function is pure (no I/O) so the same output feeds the TUI slash
 * command today and the GUI grid card later.
 */

import { resolvePluginIcon } from "./icon-resolver.ts";
import type { MarketplacePluginEntry } from "./types.ts";

export interface FormatPluginGridOptions {
	/** Terminal width in columns. Default: 80. Below 60 the renderer collapses to one column. */
	width?: number;
	/** Maximum description length per cell. Default: 64. */
	maxDescriptionLength?: number;
	/** Group entries by marketplace when set (groups under `Marketplace: <name>` headers). */
	groupByMarketplace?: boolean;
}

interface DecoratedEntry {
	entry: MarketplacePluginEntry;
	icon: string;
	marketplace: string | null;
}

function decorate(entries: ReadonlyArray<MarketplacePluginEntry>): DecoratedEntry[] {
	return entries.map(entry => {
		const marketplace = parsePluginId(entry.name)?.marketplace ?? null;
		return {
			entry,
			icon: resolvePluginIcon(entry),
			marketplace,
		};
	});
}

function parsePluginId(id: string): { name: string; marketplace: string } | null {
	// Mirror the shape used by the marketplace registry; kept local so this
	// module has no compile-time dependency on types.ts helpers.
	const at = id.lastIndexOf("@");
	if (at <= 0 || at === id.length - 1) return null;
	return { name: id.slice(0, at), marketplace: id.slice(at + 1) };
}

/**
 * Render a marketplace plugin list as a multi-line grid string. Pass the
 * result directly to `runtime.output()` or write it to a file.
 */
export function formatPluginGrid(
	entries: ReadonlyArray<MarketplacePluginEntry>,
	options: FormatPluginGridOptions = {},
): string {
	if (entries.length === 0) return "No plugins available in configured marketplaces";
	const width = options.width ?? 80;
	const maxDesc = options.maxDescriptionLength ?? 64;
	const items = decorate(entries);

	const lines: string[] = [];
	lines.push(`Available plugins (${entries.length})`);

	if (options.groupByMarketplace) {
		const groups = new Map<string, DecoratedEntry[]>();
		for (const item of items) {
			const key = item.marketplace ?? "(unscoped)";
			const list = groups.get(key);
			if (list) list.push(item);
			else groups.set(key, [item]);
		}
		for (const [marketplace, group] of groups.entries()) {
			lines.push("");
			lines.push(`Marketplace: ${marketplace}`);
			lines.push(renderGrid(group, width, maxDesc));
		}
	} else {
		lines.push("");
		lines.push(renderGrid(items, width, maxDesc));
	}

	return lines.join("\n");
}

function renderGrid(items: ReadonlyArray<DecoratedEntry>, width: number, maxDesc: number): string {
	// Reserve space for icon (2 cells + space), name+version column, and the
	// 4-space indent prefix; columns split when width >= 72, otherwise fall
	// back to single-column for narrow terminals.
	const TWO_COLUMN_THRESHOLD = 72;
	const out: string[] = [];

	if (width >= TWO_COLUMN_THRESHOLD) {
		// Two cards per row. Each card is `width/2 - 2` cells wide so a single
		// space separates them. Wrap long descriptions inside the card.
		const cardWidth = Math.max(28, Math.floor(width / 2) - 2);
		for (let i = 0; i < items.length; i += 2) {
			const left = renderCard(items[i]!, cardWidth, maxDesc);
			const right = items[i + 1] ? renderCard(items[i + 1]!, cardWidth, maxDesc) : null;
			const leftLines = left.split("\n");
			const rightLines = right ? right.split("\n") : [];
			const rowHeight = Math.max(leftLines.length, rightLines.length);
			for (let r = 0; r < rowHeight; r++) {
				const l = padRight(leftLines[r] ?? "", cardWidth);
				const r2 = padRight(rightLines[r] ?? "", cardWidth);
				out.push(`${l}  ${r2}`.trimEnd());
			}
		}
	} else {
		for (const item of items) {
			out.push(renderCard(item, width - 2, maxDesc));
		}
	}

	return out.join("\n");
}

function renderCard(item: DecoratedEntry, width: number, maxDesc: number): string {
	const header = formatHeader(item);
	const description = formatDescription(item.entry.description, maxDesc);
	const out: string[] = [header];
	if (description) {
		const wrapped = wrapText(description, width);
		for (const line of wrapped) out.push(`    ${line}`);
	}
	return out.join("\n");
}

function formatHeader(item: DecoratedEntry): string {
	const { entry, icon } = item;
	const version = entry.version ? `@${entry.version}` : "";
	return `${icon} ${entry.name}${version}`;
}

function formatDescription(desc: string | undefined, maxLength: number): string | undefined {
	if (!desc) return undefined;
	const trimmed = desc.replace(/\s+/g, " ").trim();
	if (trimmed.length <= maxLength) return trimmed;
	return `${trimmed.slice(0, Math.max(0, maxLength - 1))}…`;
}

function wrapText(text: string, width: number): string[] {
	const words = text.split(/\s+/);
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		if (!current.length) {
			current = word;
			continue;
		}
		if (current.length + 1 + word.length <= width) {
			current = `${current} ${word}`;
		} else {
			lines.push(current);
			current = word;
		}
	}
	if (current.length) lines.push(current);
	return lines;
}

function padRight(text: string, width: number): string {
	if (text.length >= width) return text.slice(0, width);
	return `${text}${" ".repeat(width - text.length)}`;
}
