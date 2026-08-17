import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { RpcClient } from "../../lib/rpc";

/** Settings → 智能体 → 预设:命名预设(工具集 + 提示词 + settings 覆盖)卡片面板
 *  (DSH agent-presets seat 形态)。列表 + 校验 + 删除;完整编辑器为后续迭代。
 *  数据源 daemon modes.list(MUSEPI_MODES_DIR 下的 <id>.json);modes.changed 即时刷新。 */

interface ModeRow {
	id: string;
	label: string;
	description?: string;
	extends: string[];
	extensions?: string[];
	hasPrompt: boolean;
	promptComplete: boolean;
	settingsKeys: string[];
	/** 内置模板(work/chat/design/creator):不可删(DSH built-in roster 对齐)。 */
	builtin?: boolean;
}

export function ModesSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [modes, setModes] = useState<ModeRow[] | null>(null);
	const [errors, setErrors] = useState<string[]>([]);
	const [validation, setValidation] = useState<Record<string, string[]>>({});

	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		const load = (): void => {
			if (document.visibilityState === "hidden") return;
			void rpc
				.request<{ modes: ModeRow[] } | null>("modes.list", {})
				.then(res => {
					if (!alive) return;
					setModes(res?.modes ?? []);
					setErrors([]);
				})
				.catch(error => {
					if (!alive) return;
					setModes([]);
					setErrors([String(error)]);
				});
		};
		load();
		const id = setInterval(load, 5000);
		const off = rpc.addEventListener(event => {
			const payload = event.payload as { type?: string } | undefined;
			if (payload?.type === "modes.changed") load();
		});
		return () => {
			alive = false;
			clearInterval(id);
			off();
		};
	}, [rpc]);

	const validate = (id: string): void => {
		if (!rpc) return;
		void rpc
			.request<{ valid: boolean; errors: string[] }>("modes.validate", { id })
			.then(res => setValidation(v => ({ ...v, [id]: res.valid ? [] : (res.errors ?? []) })))
			.catch(error => setValidation(v => ({ ...v, [id]: [String(error)] })));
	};

	const remove = (id: string): void => {
		if (!rpc) return;
		void rpc
			.request("modes.delete", { id })
			.then(() => {
				setModes(prev => (prev ? prev.filter(m => m.id !== id) : prev));
				setErrors([]);
			})
			.catch(error => setErrors([String(error)]));
	};

	return (
		<>
			<h2 className="gui-settings-page-title">{t("modes title")}</h2>
			<p className="gui-settings-page-desc">{t("modes description")}</p>
			{errors.length > 0 && (
				<div className="gui-settings-row text-[12px] text-[var(--color-danger)]">{errors.join("; ")}</div>
			)}
			{modes === null ? (
				<div className="gui-settings-row text-[12px] text-[var(--color-text-muted)]">{t("loading")}</div>
			) : modes.length === 0 ? (
				<div className="gui-settings-row text-[12px] text-[var(--color-text-muted)]">{t("modes empty")}</div>
			) : (
				<div className="mt-2 flex flex-col gap-2">
					{modes.map(mode => (
						<div key={mode.id} className="gui-agent-card">
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-1.5">
									<span className="truncate text-[13px] font-medium">{mode.label}</span>
									<span className="text-[11px] text-[var(--color-text-faint)]">({mode.id})</span>
									{mode.promptComplete ? (
										<span className="gui-provider-chip">{t("modes complete badge")}</span>
									) : null}
									{mode.extensions?.length === 0 ? (
										<span className="gui-provider-chip">{t("modes core-only badge")}</span>
									) : null}
									{mode.settingsKeys.length > 0 ? (
										<span className="gui-provider-chip">
											{t("{count} settings", { count: String(mode.settingsKeys.length) })}
										</span>
									) : null}
								</div>
								{mode.description ? (
									<div className="mt-0.5 text-[12px] text-[var(--color-text-muted)]">{mode.description}</div>
								) : null}
								{mode.extends.length > 0 ? (
									<div className="mt-0.5 text-[12px] text-[var(--color-text-faint)]">
										{t("modes based on")} {mode.extends.join(" + ")}
									</div>
								) : null}
								<div className="mt-1.5 flex items-center gap-2">
									<button
										type="button"
										className="text-[12px] text-[var(--color-accent)] hover:underline disabled:opacity-50"
										onClick={() => validate(mode.id)}
									>
										{t("modes validate")}
									</button>
									{mode.builtin !== true && (
										<button
											type="button"
											className="text-[12px] text-[var(--color-danger)] hover:underline"
											onClick={() => remove(mode.id)}
										>
											{t("modes delete")}
										</button>
									)}
								</div>
								{validation[mode.id]?.length > 0 && (
									<div className="mt-1 text-[12px] text-[var(--color-danger)]">
										{validation[mode.id].join("; ")}
									</div>
								)}
							</div>
						</div>
					))}
				</div>
			)}
		</>
	);
}
