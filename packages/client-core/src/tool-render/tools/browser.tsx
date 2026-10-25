/** `browser` — drive a Chromium tab: open/close named tabs, run puppeteer scripts. */
import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import { Badge, CodeBlock, ResultImages, ResultText, type Tone } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, homePath, isRecord, num, str, truncate } from "../util";
import { type BrowserOperation, browserActionLabel, browserOperationsOf } from "./browser-activity";

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

function Summary({ args, result }: ToolRenderProps): ReactNode {
	const details = detailsOf(result);
	const action = str(args.action) ?? details.action ?? "?";
	const closeAll = action === "close" && (args.all === true || (str(args.name) === null && details.name === null));
	const tab = details.name ?? str(args.name) ?? "main";
	const url = details.url ?? str(args.url);
	const current = details.operations.findLast(operation => operation.status === "running");
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
			{details.operations.length > 0 && (
				<div className="tv-browser-operations">
					{details.operations.map(operation => (
						<div className="tv-browser-operation" data-status={operation.status} key={operation.id}>
							<Badge
								tone={operation.status === "failed" ? "err" : operation.status === "running" ? "accent" : "ok"}
							>
								{browserActionLabel(operation.action)}
							</Badge>
							{operation.target && <span className="tv-browser-operation-target">{operation.target}</span>}
							{operation.elementCount !== undefined && (
								<span
									aria-label={t("tools.browserElementsWithCount", { count: String(operation.elementCount) })}
								>
									{operation.elementCount}
								</span>
							)}
							<small>{operationStatus(operation)}</small>
							{operation.error && <div className="tv-browser-operation-error">{operation.error}</div>}
						</div>
					))}
				</div>
			)}
			{action === "run" && code !== null && <CodeBlock code={code.replace(/\s+$/, "")} lang="javascript" />}
			<ResultImages result={result} />
			<ResultText result={result} maxLines={10} />
		</>
	);
}

export const browserRenderer: ToolRenderer = { Summary, Body };
