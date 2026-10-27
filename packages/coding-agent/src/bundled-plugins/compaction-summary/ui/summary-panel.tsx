import type { ReactNode } from "react";
import "./summary-panel.css";

declare const React: {
	createElement: (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => ReactNode;
	useEffect: (fn: () => void | (() => void), deps?: readonly unknown[]) => void;
	useState: <T>(initial: T) => [T, (value: T) => void];
};

interface CompactionEntry {
	id: string;
	type: "compaction";
	summary: string;
	shortSummary?: string;
	tokensBefore: number;
	tokensAfter?: number;
	method?: string;
	warning?: string;
}

interface SummaryPanelProps {
	rpc?: {
		request<T>(method: string, params?: unknown): Promise<T>;
	} | null;
	sessionId?: string | null;
	panelTab?: {
		id: string;
		surface: string;
		target: string | null;
		label: string;
		readOnly: boolean;
	};
	formatTokens?: (value: number) => string;
}

interface LoadState {
	status: "loading" | "ready" | "error";
	entry: CompactionEntry | null;
	error: string | null;
}

const NAMESPACE = "compaction-summary";
const DICTIONARIES: Record<string, Record<string, string>> = {
	"zh-CN": {
		title: "压缩摘要",
		loading: "正在读取摘要…",
		empty: "没有找到这条压缩摘要。",
		unavailable: "选择一个压缩摘要标签后，这里会显示完整内容。",
		before: "压缩前",
		after: "压缩后",
		method: "方式",
		warning: "注意",
	},
	"en-US": {
		title: "Compaction summary",
		loading: "Loading summary…",
		empty: "This compaction summary was not found.",
		unavailable: "Open a compaction tab to read its full summary.",
		before: "Before",
		after: "After",
		method: "Method",
		warning: "Notice",
	},
};

function t(key: string): string {
	return window.MusePiI18n?.bind(NAMESPACE)(key) ?? DICTIONARIES["zh-CN"]![key] ?? key;
}

export function apply(ctx: { effect(dispose: () => void): void }): void {
	window.MusePiI18n?.register(NAMESPACE, DICTIONARIES);
	ctx.effect(() => window.MusePiI18n?.unregister(NAMESPACE));
}

export function CompactionSummaryPanel({
	rpc,
	sessionId,
	panelTab,
	formatTokens = String,
}: SummaryPanelProps): ReactNode {
	const entryId = panelTab?.target ?? null;
	const [state, setState] = React.useState<LoadState>({ status: "loading", entry: null, error: null });
	React.useEffect(() => {
		let alive = true;
		if (!rpc || !sessionId || !entryId) {
			setState({ status: "error", entry: null, error: null });
			return () => {
				alive = false;
			};
		}
		setState({ status: "loading", entry: null, error: null });
		void rpc
			.request<{ entry: CompactionEntry | null }>("session.compaction", { sessionId, entryId })
			.then(result => {
				if (alive) setState({ status: "ready", entry: result.entry, error: null });
			})
			.catch((error: unknown) => {
				if (alive) setState({ status: "error", entry: null, error: String(error) });
			});
		return () => {
			alive = false;
		};
	}, [rpc, sessionId, entryId]);

	if (state.status === "loading")
		return React.createElement("div", { className: "compaction-summary-state" }, t("loading"));
	if (state.status === "error") {
		return React.createElement(
			"div",
			{ className: "compaction-summary-state compaction-summary-state--error", role: "alert" },
			state.error ?? t("unavailable"),
		);
	}
	const entry = state.entry;
	if (!entry) return React.createElement("div", { className: "compaction-summary-state" }, t("empty"));

	return React.createElement(
		"article",
		{ className: "compaction-summary" },
		React.createElement(
			"header",
			{ className: "compaction-summary-header" },
			React.createElement("h2", null, t("title")),
			React.createElement(
				"div",
				{ className: "compaction-summary-tokens" },
				React.createElement("span", null, `${t("before")} ${formatTokens(entry.tokensBefore)}`),
				React.createElement("span", { "aria-hidden": "true" }, "→"),
				React.createElement(
					"strong",
					null,
					entry.tokensAfter === undefined ? "—" : `${t("after")} ${formatTokens(entry.tokensAfter)}`,
				),
			),
			entry.method &&
				React.createElement("div", { className: "compaction-summary-method" }, `${t("method")} · ${entry.method}`),
		),
		entry.warning &&
			React.createElement("div", { className: "compaction-summary-warning" }, `${t("warning")}: ${entry.warning}`),
		React.createElement("pre", { className: "compaction-summary-body" }, entry.summary),
	);
}

export default CompactionSummaryPanel;

declare const window: {
	MusePiI18n?: {
		register(namespace: string, dictionaries: Record<string, Record<string, string>>): void;
		unregister(namespace: string): void;
		bind(namespace: string): (key: string) => string;
	};
};
