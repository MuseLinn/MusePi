/**
 * Turn "来源" card: the pages the agent browsed while answering, split into
 * the ones it read and the ones it only passed through.
 *
 * Collapsed by default like the round fold — the header already carries the
 * count, and the full list is one click away. Every action is capability-
 * gated: a guest/export render has no managed browser panel and no clipboard,
 * so those buttons render disabled instead of silently doing nothing.
 */
import { ArrowUpRight, Check, ChevronRight, Globe, Link2, PanelRight } from "lucide-react";
import type { ReactNode } from "react";
import { useRef, useState } from "react";
import { t } from "../../i18n/index.js";
import { collapseStyle, useCollapseHeight } from "../../lib/use-collapse.js";
import { sourceHost, type TurnSourcePage, type TurnSources } from "./turn-sources.js";

export interface TurnSourceCapabilities {
	/** Open in the managed right-panel browser (`musepi-open-url`). */
	openInPanel?: (url: string) => void;
	/** Hand the URL to the system browser. */
	openExternal?: (url: string) => void;
	/** Copy the URL to the clipboard. */
	copyLink?: (url: string) => void;
}

/** Capabilities of the current host; absent members render their button
 *  disabled. */
export function sourceCapabilities(): TurnSourceCapabilities {
	if (typeof window === "undefined") return {};
	const capabilities: TurnSourceCapabilities = {
		openInPanel: url => {
			window.dispatchEvent(new CustomEvent("musepi-open-url", { detail: { url } }));
		},
		openExternal: url => {
			window.open(url, "_blank", "noopener,noreferrer");
		},
	};
	const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
	if (clipboard !== undefined) {
		capabilities.copyLink = url => {
			void clipboard.writeText(url).catch(() => {
				// clipboard blocked (insecure context) — the button keeps its label
			});
		};
	}
	return capabilities;
}

/** Header summary: read-only, read+passed, or browse-only. */
function headline(sources: TurnSources): string {
	if (sources.readCount > 0 && sources.passedCount > 0) {
		return t("transcript.sourcesReadAndPassed", {
			read: String(sources.readCount),
			passed: String(sources.passedCount),
		});
	}
	if (sources.readCount > 0) {
		return t("transcript.sourcesReadWithCount", { count: String(sources.readCount) });
	}
	return t("transcript.sourcesVisitedWithCount", { count: String(sources.passedCount) });
}

function SourceRow({
	page,
	capabilities,
	copied,
	onCopy,
}: {
	page: TurnSourcePage;
	capabilities: TurnSourceCapabilities;
	copied: boolean;
	onCopy: (url: string) => void;
}): ReactNode {
	const label = page.title || sourceHost(page.url);
	return (
		<div className="tr-sources-row">
			<Globe size={12} className="tr-sources-icon" aria-hidden="true" />
			<div className="tr-sources-main">
				<div className="tr-sources-title-line">
					<span className="tr-sources-title" title={page.url}>
						{label}
					</span>
					<span className={`tr-sources-tag${page.read ? " tr-sources-tag--read" : ""}`}>
						{page.read ? t("transcript.sourcesReadTag") : t("transcript.sourcesPassedTag")}
					</span>
					{page.opens > 1 && (
						<span className="tr-sources-visits">
							{t("transcript.sourcesVisitsWithCount", { count: String(page.opens) })}
						</span>
					)}
				</div>
				<span className="tr-sources-url" title={page.url}>
					{page.url}
				</span>
			</div>
			<span className="tr-sources-actions">
				<button
					type="button"
					className="tr-sources-act"
					title={t("transcript.sourcesOpenSidebar")}
					aria-label={t("transcript.sourcesOpenSidebar")}
					disabled={capabilities.openInPanel === undefined}
					onClick={() => capabilities.openInPanel?.(page.url)}
				>
					<PanelRight size={12} />
				</button>
				<button
					type="button"
					className="tr-sources-act"
					title={t("transcript.sourcesOpenExternal")}
					aria-label={t("transcript.sourcesOpenExternal")}
					disabled={capabilities.openExternal === undefined}
					onClick={() => capabilities.openExternal?.(page.url)}
				>
					<ArrowUpRight size={12} />
				</button>
				<button
					type="button"
					className="tr-sources-act"
					title={copied ? t("transcript.sourcesCopied") : t("transcript.sourcesCopy")}
					aria-label={copied ? t("transcript.sourcesCopied") : t("transcript.sourcesCopy")}
					disabled={capabilities.copyLink === undefined}
					onClick={() => {
						capabilities.copyLink?.(page.url);
						onCopy(page.url);
					}}
				>
					{copied ? <Check size={12} /> : <Link2 size={12} />}
				</button>
			</span>
		</div>
	);
}

export function TurnSourcesCard({
	sources,
	capabilities = sourceCapabilities(),
}: {
	sources: TurnSources;
	capabilities?: TurnSourceCapabilities;
}): ReactNode {
	const [open, setOpen] = useState(false);
	const [copied, setCopied] = useState<string | null>(null);
	const bodyRef = useRef<HTMLDivElement | null>(null);
	useCollapseHeight(open, bodyRef);
	if (sources.pages.length === 0) return null;
	const read = sources.pages.filter(page => page.read);
	const passed = sources.pages.filter(page => !page.read);
	const groups: { key: string; title: string; pages: TurnSourcePage[] }[] = [
		{ key: "read", title: t("transcript.sourcesReadGroup"), pages: read },
		{ key: "passed", title: t("transcript.sourcesPassedGroup"), pages: passed },
	];
	return (
		<div className="tr-sources">
			<button
				type="button"
				className={`tr-sources-head${open ? " tr-sources-head--open" : ""}`}
				aria-expanded={open}
				aria-label={t("transcript.sourcesLabel")}
				onClick={() => setOpen(value => !value)}
			>
				<Globe size={12} className="tr-sources-head-icon" aria-hidden="true" />
				<span className="tr-sources-headline">{headline(sources)}</span>
				<ChevronRight size={12} className="tr-sources-chev" aria-hidden="true" />
			</button>
			<div
				ref={bodyRef}
				className={`tr-sources-body${open ? "" : " tr-sources-body--closed"}`}
				style={collapseStyle(open)}
			>
				{groups.map(group =>
					group.pages.length === 0 ? null : (
						<section className="tr-sources-group" key={group.key}>
							<div className="tr-sources-group-title">{group.title}</div>
							{group.pages.map(page => (
								<SourceRow
									key={page.url}
									page={page}
									capabilities={capabilities}
									copied={copied === page.url}
									onCopy={setCopied}
								/>
							))}
						</section>
					),
				)}
			</div>
		</div>
	);
}
