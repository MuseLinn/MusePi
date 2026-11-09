/** `browser` — drive a Chromium tab: open/close named tabs, run puppeteer scripts. */
import {
	ArrowDown,
	Camera,
	ChevronRight,
	Clock,
	Code as CodeIcon,
	Eye,
	Globe,
	Hand,
	Keyboard,
	ListChecks,
	type LucideIcon,
	MousePointerClick,
	Type,
	Upload,
} from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { t } from "../../i18n/index.js";
import { Badge, CodeBlock, ResultImages, ResultText, type Tone } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, homePath, isRecord, num, str, truncate } from "../util";
import {
	type BrowserOperation,
	browserActionLabel,
	browserCallStats,
	browserOperationGroups,
	browserOperationsOf,
} from "./browser-activity";
import { browserStructuredOf, StructuredBrowserResult } from "./browser-structured";

interface BrowserDetails {
	action: string | null;
	name: string | null;
	url: string | null;
	browser: string | null;
	operations: BrowserOperation[];
}

function detailsOf(result: ToolRenderProps["result"]): BrowserDetails {
	const d = detailsRecord(result);
	return {
		action: d ? str(d.action) : null,
		name: d ? str(d.name) : null,
		url: d ? str(d.url) : null,
		browser: d ? str(d.browser) : null,
		operations: browserOperationsOf(d),
	};
}

interface AppArg {
	path: string | null;
	cdpUrl: string | null;
	target: string | null;
}

function appOf(args: Record<string, unknown>): AppArg | null {
	if (!isRecord(args.app)) return null;
	return { path: str(args.app.path), cdpUrl: str(args.app.cdp_url), target: str(args.app.target) };
}

function actionTone(action: string): Tone | undefined {
	switch (action) {
		case "open":
			return "ok";
		case "run":
			return "accent";
		case "close":
			return "warn";
		default:
			return undefined;
	}
}

/** Mirrors the TUI's `describeBrowser`: explicit app args win over reported mode. */
function describeBrowser(app: AppArg | null, details: BrowserDetails): string | null {
	if (app?.cdpUrl) return t("tools.connectedWithValue", { value: app.cdpUrl });
	if (app?.path) return t("tools.spawnedWithPath", { path: homePath(app.path) });
	return details.browser;
}

function operationStatus(operation: BrowserOperation): string {
	if (operation.status === "running") return t("tools.dispatched");
	if (operation.status === "failed") return t("tools.failed");
	if (operation.status === "canceled") return t("tools.canceled");
	return t("tools.completed");
}

const STEP_ICONS: Record<BrowserOperation["action"], LucideIcon> = {
	goto: Globe,
	observe: Eye,
	click: MousePointerClick,
	fill: Type,
	type: Type,
	press: Keyboard,
	select: ListChecks,
	scroll: ArrowDown,
	drag: Hand,
	hover: MousePointerClick,
	screenshot: Camera,
	evaluate: CodeIcon,
	upload: Upload,
	wait: Clock,
};

function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "";
	const seconds = Math.max(1, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return rest > 0 ? `${minutes}m${rest}s` : `${minutes}m`;
}

function pageLabel(url: string, title: string): string {
	if (title) return title;
	if (url) return homePath(url);
	return t("transcript.browserPageFallback");
}

/** Jump to the managed browser's agent tab (ChatView opens the panel). */
function openBrowser(url: string | undefined): void {
	if (!url || typeof window === "undefined") return;
	window.dispatchEvent(new CustomEvent("musepi-open-url", { detail: { url } }));
	// After the panel mounts, point it at the agent tab these steps ran in.
	const focusAgent = (): void => {
		window.dispatchEvent(new Event("musepi-browser-focus-agent"));
	};
	if (typeof requestAnimationFrame === "function") requestAnimationFrame(focusAgent);
	else window.setTimeout(focusAgent, 50);
}

function Summary({ args, result }: ToolRenderProps): ReactNode {
	const details = detailsOf(result);
	const action = str(args.action) ?? details.action ?? "?";
	const closeAll = action === "close" && (args.all === true || (str(args.name) === null && details.name === null));
	const tab = details.name ?? str(args.name) ?? "main";
	const url = details.url ?? str(args.url);
	const current = details.operations.findLast(operation => operation.status === "running");
	const failures = details.operations.filter(operation => operation.status === "failed").length;
	return (
		<>
			<Badge tone={actionTone(action)}>{action}</Badge>
			<span>{closeAll ? t("tools.allTabs") : tab}</span>
			{args.kill === true && <Badge tone="err">{t("settings.kill")}</Badge>}
			{current ? (
				<span className="tv-faint">{browserActionLabel(current.action)}</span>
			) : details.operations.length > 0 ? (
				<span className="tv-faint">
					{t("tools.browserStepsWithCount", { count: String(details.operations.length) })}
				</span>
			) : null}
			{failures > 0 && (
				<span className="tv-err">{t("transcript.browserRunFailures", { count: String(failures) })}</span>
			)}
			{url && <span className="tv-faint">{truncate(homePath(url), 72)}</span>}
		</>
	);
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const details = detailsOf(result);
	const action = str(args.action) ?? details.action;
	const app = appOf(args);
	const tab = details.name ?? str(args.name);
	const url = details.url ?? str(args.url);
	const browserDesc = describeBrowser(app, details);
	const viewport = isRecord(args.viewport) ? args.viewport : null;
	const vpWidth = viewport ? num(viewport.width) : null;
	const vpHeight = viewport ? num(viewport.height) : null;
	const vpScale = viewport ? num(viewport.scale) : null;
	const code = str(args.code);
	const structured = browserStructuredOf(result);
	const detailRecord = detailsRecord(result);
	const directScreenshots =
		detailRecord && Array.isArray(detailRecord.screenshots) ? detailRecord.screenshots.length : 0;
	const stats = browserCallStats(details.operations);
	const screenshots = Math.max(stats.screenshots, directScreenshots);
	const duration = formatDuration(stats.durationMs);
	const groups = browserOperationGroups(details.operations, url);
	const jumpUrl = url ?? groups.find(group => group.url)?.url;
	const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set());
	const toggle = (id: string): void => {
		setOpenIds(current => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};
	return (
		<>
			<span className="tv-badges">
				{tab !== null && <Badge>{t("tools.tabWithValue", { value: tab })}</Badge>}
				{url && <Badge tone="accent">{truncate(homePath(url), 120)}</Badge>}
				{browserDesc && <Badge>{browserDesc}</Badge>}
				{app?.target && <Badge>{t("tools.targetWithValue", { value: app.target })}</Badge>}
				{args.all === true && <Badge tone="warn">{t("tools.all")}</Badge>}
				{args.kill === true && <Badge tone="err">{t("settings.kill")}</Badge>}
				{vpWidth !== null && vpHeight !== null && (
					<Badge>
						{vpWidth}×{vpHeight}
						{vpScale !== null ? `@${vpScale}x` : ""}
					</Badge>
				)}
			</span>
			<StructuredBrowserResult action={action} result={result} />
			{details.operations.length > 0 && (
				<>
					<div className="tv-browser-run-summary">
						<span className="tv-browser-run-stats">
							{stats.pages > 0 && <span>{t("transcript.browserRunPages", { count: String(stats.pages) })}</span>}
							{stats.clicks > 0 && (
								<span>{t("transcript.browserRunClicks", { count: String(stats.clicks) })}</span>
							)}
							{screenshots > 0 && (
								<span>{t("transcript.browserRunScreenshots", { count: String(screenshots) })}</span>
							)}
							{stats.failures > 0 && (
								<span className="tv-browser-run-fail">
									{t("transcript.browserRunFailures", { count: String(stats.failures) })}
								</span>
							)}
							{duration && <span className="tv-browser-run-time">{duration}</span>}
						</span>
						{jumpUrl && (
							<button type="button" className="tv-browser-open" onClick={() => openBrowser(jumpUrl)}>
								{t("transcript.browserOpen")}
							</button>
						)}
					</div>
					<div className="tv-browser-pages">
						{groups.map(group => (
							<section className="tv-browser-page" key={group.url || "current"}>
								<div className="tv-browser-page-head">
									<Globe size={11} className="tv-browser-page-icon" aria-hidden="true" />
									<button
										type="button"
										className="tv-browser-page-title"
										onClick={() => openBrowser(group.url || jumpUrl)}
										disabled={!group.url && !jumpUrl}
										title={group.url || undefined}
									>
										{pageLabel(group.url, group.title)}
									</button>
									<span className="tv-browser-page-meta">
										{t("transcript.browserStepCount", { count: String(group.operations.length) })}
										{group.durationMs > 0 ? ` · ${formatDuration(group.durationMs)}` : ""}
									</span>
									{group.thumbnail && (
										<img
											className="tv-browser-page-thumb"
											src={group.thumbnail}
											alt=""
											loading="lazy"
											onClick={() => openBrowser(group.url || jumpUrl)}
										/>
									)}
								</div>
								{group.operations.map(operation => {
									const StepIcon = STEP_ICONS[operation.action] ?? Globe;
									const open = openIds.has(operation.id);
									const elapsed = formatDuration(
										operation.endedAt !== undefined ? operation.endedAt - operation.startedAt : 0,
									);
									const targetUrl = operation.pageUrl ?? group.url ?? jumpUrl;
									return (
										<div className="tv-browser-step" data-status={operation.status} key={operation.id}>
											<button
												type="button"
												className="tv-browser-step-head"
												aria-expanded={open}
												onClick={() => toggle(operation.id)}
											>
												<StepIcon size={12} className="tv-browser-step-icon" aria-hidden="true" />
												<span className="tv-browser-step-label">
													{browserActionLabel(operation.action)}
												</span>
												{operation.thumbnail && (
													<img
														className="tv-browser-step-thumb"
														src={operation.thumbnail}
														alt=""
														loading="lazy"
														onClick={event => {
															event.stopPropagation();
															openBrowser(targetUrl);
														}}
													/>
												)}
												{operation.target && (
													<span className="tv-browser-step-target" title={operation.target}>
														{operation.target}
													</span>
												)}
												{operation.x !== undefined && operation.y !== undefined && (
													<span className="tv-browser-step-coords">
														({operation.x}, {operation.y})
													</span>
												)}
												{operation.elementCount !== undefined && (
													<span className="tv-browser-step-elements">
														{t("tools.browserElementsWithCount", {
															count: String(operation.elementCount),
														})}
													</span>
												)}
												{operation.status === "failed" && (
													<span className="tv-browser-step-fail">{t("tools.failed")}</span>
												)}
												{elapsed && <span className="tv-browser-step-time">{elapsed}</span>}
												<ChevronRight
													size={12}
													className={`tv-browser-step-chev${open ? " is-open" : ""}`}
													aria-hidden="true"
												/>
											</button>
											{open && (
												<div className="tv-browser-step-detail">
													<span>{operationStatus(operation)}</span>
													{operation.pageTitle && <span>{operation.pageTitle}</span>}
													{operation.pageUrl && (
														<button
															type="button"
															className="tv-browser-step-url"
															onClick={() => openBrowser(operation.pageUrl)}
														>
															{homePath(operation.pageUrl)}
														</button>
													)}
													{operation.error && (
														<div className="tv-browser-step-error">{operation.error}</div>
													)}
												</div>
											)}
										</div>
									);
								})}
							</section>
						))}
					</div>
				</>
			)}
			{action === "run" && code !== null && <CodeBlock code={code.replace(/\s+$/, "")} lang="javascript" />}
			<ResultImages result={result} />
			{!structured && <ResultText result={result} maxLines={10} />}
		</>
	);
}

export const browserRenderer: ToolRenderer = { Summary, Body };
