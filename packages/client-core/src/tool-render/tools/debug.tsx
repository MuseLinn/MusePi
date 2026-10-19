/** `debug` — DAP debugger sessions: launch/attach, breakpoints, stepping, evaluate. */
import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import { Badge, CodeBlock, Kv, KvGrid, PathText, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, display, isRecord, normalizeWs, num, str, truncate } from "../util";

/** Session snapshot the TUI renders as its "settings.session" section (details.snapshot). */
interface SessionSnapshot {
	id: string | null;
	adapter: string | null;
	status: string | null;
	program: string | null;
	stopReason: string | null;
	frameName: string | null;
	sourcePath: string | null;
	line: number | null;
	column: number | null;
	exitCode: number | null;
	needsConfigurationDone: boolean;
}

function snapshotOf(result: ToolRenderProps["result"]): SessionSnapshot | null {
	const rec = detailsRecord(result);
	if (!rec || !isRecord(rec.snapshot)) return null;
	const snap = rec.snapshot;
	const source = isRecord(snap.source) ? snap.source : null;
	return {
		id: str(snap.id) ?? (num(snap.id) !== null ? String(snap.id) : null),
		adapter: str(snap.adapter),
		status: str(snap.status),
		program: str(snap.program),
		stopReason: str(snap.stopReason),
		frameName: str(snap.frameName),
		sourcePath: source ? str(source.path) : null,
		line: num(snap.line),
		column: num(snap.column),
		exitCode: num(snap.exitCode),
		needsConfigurationDone: snap.needsConfigurationDone === true,
	};
}

function actionOf(props: ToolRenderProps): string {
	const action = str(props.args.action) ?? str(detailsRecord(props.result)?.action);
	return action ? action.replace(/_/g, " ") : t("tools.request");
}

/** Mirrors the TUI's summarizeDebugCall target priority. */
function targetTextOf(args: Record<string, unknown>): string | null {
	return (
		str(args.function) ??
		str(args.expression) ??
		str(args.command) ??
		str(args.memory_reference) ??
		str(args.instruction_reference) ??
		str(args.data_id) ??
		str(args.name)
	);
}

function Summary(props: ToolRenderProps): ReactNode {
	const { args } = props;
	const program = str(args.program);
	const file = str(args.file);
	const line = num(args.line);
	const target = targetTextOf(args);
	return (
		<>
			<Badge tone="accent">{actionOf(props)}</Badge>
			{program !== null ? (
				<PathText path={program} />
			) : file !== null ? (
				<PathText path={file} from={line ?? undefined} />
			) : target !== null ? (
				<span>{truncate(normalizeWs(target), 80)}</span>
			) : null}
		</>
	);
}

/** Scalar args worth a KvGrid row, in display order (program/file/expression are special-cased). */
const SCALAR_ARGS = [
	["tools.adapter", "tools.adapter"],
	["settings.cwd", "settings.cwd"],
	["tools.function", "tools.function"],
	["tools.name", "tools.name"],
	["tools.condition", "tools.condition"],
	["hit_condition", "tools.hitCondition"],
	["settings.context", "settings.context"],
	["frame_id", "tools.frameId"],
	["scope_id", "tools.scopeId"],
	["variable_ref", "tools.variableRef"],
	["tools.pid", "tools.pid"],
	["settings.host", "settings.host"],
	["tools.port", "tools.port"],
	["tools.levels", "tools.levels"],
	["memory_reference", "tools.memoryRef"],
	["instruction_reference", "tools.instructionRef"],
	["instruction_count", "tools.instructionCount"],
	["instruction_offset", "tools.instructionOffset"],
	["tools.offset", "tools.offset"],
	["tools.count", "tools.count"],
	["tools.data", "tools.data"],
	["data_id", "tools.dataId"],
	["access_type", "tools.access"],
	["tools.command", "tools.command"],
	["resolve_symbols", "tools.resolveSymbols"],
	["allow_partial", "tools.allowPartial"],
	["start_module", "tools.startModule"],
	["module_count", "tools.moduleCount"],
	["tools.timeout", "tools.timeout"],
] as const;

function Body(props: ToolRenderProps): ReactNode {
	const { args, result } = props;
	const program = str(args.program);
	const file = str(args.file);
	const line = num(args.line);
	const expression = str(args.expression);
	const programArgs = Array.isArray(args.args) ? args.args.filter(a => typeof a === "string") : [];

	const argRows: ReactNode[] = [];
	if (program !== null) {
		argRows.push(
			<Kv key="tools.program" k="tools.program">
				<PathText path={program} />
			</Kv>,
		);
	}
	if (programArgs.length > 0) {
		argRows.push(
			<Kv key="tools.args" k="tools.args">
				{truncate(programArgs.join(" "), 160)}
			</Kv>,
		);
	}
	if (file !== null) {
		argRows.push(
			<Kv key="tools.file" k="tools.file">
				<PathText path={file} from={line ?? undefined} />
			</Kv>,
		);
	} else if (line !== null) {
		argRows.push(
			<Kv key="tools.line" k="tools.line">
				{line}
			</Kv>,
		);
	}
	for (const [key, label] of SCALAR_ARGS) {
		const value = args[key];
		if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;
		argRows.push(
			<Kv key={key} k={t(label)}>
				{truncate(display(value), 120)}
			</Kv>,
		);
	}

	let customArgsJson = "";
	if (isRecord(args.arguments)) {
		try {
			customArgsJson = JSON.stringify(args.arguments, null, 2) ?? "";
		} catch {
			customArgsJson = "";
		}
	}

	const snapshot = snapshotOf(result);
	return (
		<>
			{argRows.length > 0 && <KvGrid>{argRows}</KvGrid>}
			{expression !== null && <CodeBlock code={expression} title={t("tools.expression")} maxLines={8} />}
			{customArgsJson && <CodeBlock code={customArgsJson} lang="json" title={t("tools.arguments")} maxLines={10} />}
			{snapshot && (
				<KvGrid>
					{snapshot.id !== null && <Kv k={t("settings.session2")}>{snapshot.id}</Kv>}
					{snapshot.adapter !== null && <Kv k={t("tools.adapter")}>{snapshot.adapter}</Kv>}
					{snapshot.status !== null && (
						<Kv k={t("tools.status")}>
							<Badge tone={snapshot.status === "exited" ? "warn" : "ok"}>{snapshot.status}</Badge>
						</Kv>
					)}
					{snapshot.program !== null && (
						<Kv k={t("tools.program")}>
							<PathText path={snapshot.program} />
						</Kv>
					)}
					{snapshot.stopReason !== null && <Kv k={t("tools.stopReason")}>{snapshot.stopReason}</Kv>}
					{snapshot.frameName !== null && <Kv k={t("tools.frame")}>{snapshot.frameName}</Kv>}
					{snapshot.sourcePath !== null && snapshot.line !== null && (
						<Kv k={t("tools.location")}>
							<PathText
								path={snapshot.sourcePath}
								sel={snapshot.column !== null ? `${snapshot.line}:${snapshot.column}` : String(snapshot.line)}
							/>
						</Kv>
					)}
					{snapshot.exitCode !== null && <Kv k={t("tools.exitCode")}>{snapshot.exitCode}</Kv>}
					{snapshot.needsConfigurationDone && (
						<Kv k={t("tools.configuration")}>{t("tools.pendingConfigurationdoneSet.info")}</Kv>
					)}
				</KvGrid>
			)}
			<ResultText result={result} maxLines={10} />
		</>
	);
}

export const debugRenderer: ToolRenderer = { Summary, Body };
