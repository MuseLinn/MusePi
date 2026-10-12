/**
 * Deepdive settings panel — the plugin's own management UI.
 *
 * Runs in the GUI, compiled by the daemon's extension artifact compiler into a
 * self-contained ESM bundle: React arrives via `window.MusePiReact`, never an
 * import. Data flows through two injected props — `extensionCall` (this
 * plugin's daemon-side RPCs) and `configForm` (the namespace's settings form).
 *
 * The form is the point of this panel: rather than a bare `set`, it carries a
 * revision fence and a base/user split, so the switch reflects what the form
 * actually holds and a stale write is refused instead of clobbering.
 */
declare const React: {
	createElement: (
		type: unknown,
		props?: Record<string, unknown>,
		...children: unknown[]
	) => React.ReactNode;
	useEffect: (fn: () => void | (() => void), deps?: unknown[]) => void;
	useState: <T>(initial: T) => [T, (v: T | ((prev: T) => T)) => void];
};

/** The config form the host injects (see `SlotConfigForm`). */
interface ConfigForm {
	getSnapshot(): ConfigFormSnapshot;
	subscribe(listener: () => void): () => void;
	mutate(
		ops: readonly ({ kind: "set"; field: string; value: unknown } | { kind: "unset"; field: string })[],
		expectedRevision?: number,
	): Promise<boolean>;
	set(field: string, value: unknown): Promise<boolean>;
	unset(field: string): Promise<boolean>;
}

interface ConfigFormSnapshot {
	status: "ready" | "readonly" | "unavailable";
	value: Record<string, unknown> | undefined;
	base: Record<string, unknown> | undefined;
	user: Record<string, unknown> | undefined;
	revision: number | undefined;
	writable: boolean;
	mode: "host" | "memory";
}

interface PanelProps {
	extensionCall?: (method: string, params?: unknown) => Promise<unknown>;
	configForm?: ConfigForm | null;
}

const SETTING_FIELD = "magicKeywords.deepdive";

export default function DeepdivePanel({ extensionCall, configForm }: PanelProps): React.ReactNode {
	const [enabled, setEnabled] = React.useState(false);
	const [busy, setBusy] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);
	const [info, setInfo] = React.useState<string | null>(null);

	// Read the current value from the form whenever it publishes a new snapshot.
	React.useEffect(() => {
		if (!configForm) return;
		const sync = (): void => {
			setEnabled(configForm.getSnapshot().value?.[SETTING_FIELD] === true);
		};
		sync();
		return configForm.subscribe(sync);
	}, [configForm]);

	React.useEffect(() => {
		if (!extensionCall) return;
		let alive = true;
		void extensionCall("deepdive.describe", {})
			.then(res => {
				if (!alive) return;
				const record = res as { keyword?: string; noticeChars?: number };
				setInfo(`关键词 ${record.keyword ?? "?"} · 提示 ${record.noticeChars ?? 0} 字`);
			})
			.catch((e: unknown) => alive && setError(String(e)));
		return () => {
			alive = false;
		};
	}, [extensionCall]);

	const toggle = (): void => {
		if (!configForm || busy) return;
		setBusy(true);
		setError(null);
		void configForm
			.mutate([{ kind: "set", field: SETTING_FIELD, value: !enabled }], configForm.getSnapshot().revision)
			.then(applied => {
				// `false` means the revision moved on — someone else wrote first.
				// Re-reading is the right response; overwriting is not.
				if (!applied) setError("设置已在别处被修改，已重新读取。");
			})
			.catch((e: unknown) => setError(String(e)))
			.finally(() => setBusy(false));
	};

	if (error) {
		return React.createElement(
			"div",
			{ style: { padding: "8px 0", color: "var(--color-error, #e5484d)", fontSize: "12px" } },
			`Deepdive: ${error}`,
		);
	}

	if (!configForm) {
		return React.createElement(
			"div",
			{ style: { padding: "8px 0", fontSize: "12px", color: "var(--color-text-faint, #889)" } },
			"此宿主未提供设置表单，无法在此切换。",
		);
	}

	return React.createElement(
		"div",
		{ style: { display: "flex", flexDirection: "column", gap: "8px", padding: "8px 0" } },
		React.createElement(
			"div",
			{ style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" } },
			React.createElement(
				"div",
				{ style: { fontWeight: 600, fontSize: "13px" } },
				"深度分析关键词",
			),
			React.createElement(
				"button",
				{
					type: "button",
					role: "switch",
					"aria-checked": enabled,
					onClick: toggle,
					disabled: busy,
					style: { cursor: busy ? "wait" : "pointer", fontSize: "11px", padding: "2px 8px" },
				},
				enabled ? "已启用" : "已停用",
			),
		),
		React.createElement(
			"div",
			{ style: { fontSize: "11.5px", color: "var(--color-text-muted, #99a)" } },
			"在输入框里单独输入 deepdive 并提交，即向模型追加一条隐藏的深度分析提示。",
		),
		info
			? React.createElement(
					"div",
					{ style: { fontSize: "10.5px", color: "var(--color-text-faint, #889)" } },
					info,
				)
			: null,
	);
}
