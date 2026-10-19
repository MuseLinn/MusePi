import { tLoose } from "@musepi/client-core";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import type { RpcClient } from "../lib/rpc";
import { Icon } from "../vendor/oc-icons";

/**
 * BundleView — 能力中心的「组合」视图：这个 profile 叠了哪些 bundle、组合出
 * 哪些行、每行现在是什么状态。
 *
 * 它回答的是 `plugins.packages` 回答不了的那个问题：**装上了，然后呢。**
 * 一个 bundle 装成功却什么都不贡献（插件没装、条件启停、bundle 本身缺失）
 * 在插件清单里看不出来——那里只列已装包，不列 profile 的组合结果。
 *
 * 行的启停写进 profile 自己的 patch 文件（`bundles.rows.setEnabled`，DSH
 * 同款写法），回读组合的真实状态后落 UI——开关显示的是组合读数，不是请求。
 * `conditional` 行不给开关：这个宿主不求值那个表达式，启停是真的未知，
 * 画一个能拨的开关就是在撒谎。
 */

/** 与 daemon BundleCompositionView 对齐的 wire 形状。 */
interface BundleRow {
	id: string;
	name: string;
	state: "enabled" | "disabled" | "conditional";
	group: boolean;
	inject: string[];
	layers: string[];
	pluginPath: string | null;
	pluginIssue: "not-installed" | "disabled" | null;
	mountable: boolean;
}

interface BundleLayer {
	name: string;
	rows: number;
	overrides: number;
	unreadable: string[];
}

interface BundleComposition {
	profile: string;
	declared: "ok" | "no-manifest" | "unreadable";
	detail?: string;
	bundles: string[];
	layers: BundleLayer[];
	rows: BundleRow[];
	conditionalRows: string[];
	unevaluatedExpressions: number;
}

export function BundleView({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [composition, setComposition] = useState<BundleComposition | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busyId, setBusyId] = useState<string | null>(null);

	const load = useCallback((): void => {
		if (!rpc) return;
		void rpc
			.request<BundleComposition>("bundles.composition", {})
			.then(res => {
				setComposition(res);
				setError(null);
			})
			.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
	}, [rpc]);

	useEffect(() => {
		load();
		// The composition is derived state, so an extension change is what
		// invalidates it — the same broadcast the plugin list already listens to.
		if (!rpc) return;
		const unlisten = rpc.addEventListener(event => {
			const payload = event.payload as { type?: string } | undefined;
			if (payload?.type === "extensions.changed") load();
		});
		return unlisten;
	}, [rpc, load]);

	const toggle = useCallback(
		(row: BundleRow): void => {
			if (!rpc || busyId) return;
			setBusyId(row.id);
			void rpc
				.request<{ ok: boolean; state?: string; error?: string }>("bundles.rows.setEnabled", {
					id: row.id,
					enabled: row.state !== "enabled",
				})
				.then(res => {
					// The daemon reports the recomposed state; re-read the whole
					// composition so a toggle that a later layer overrides shows up.
					if (!res.ok) setError(res.error ?? null);
					else setError(null);
					load();
				})
				.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
				.finally(() => setBusyId(null));
		},
		[rpc, busyId, load],
	);

	const counts = useMemo(() => {
		const rows = composition?.rows ?? [];
		return {
			total: rows.length,
			enabled: rows.filter(r => r.state === "enabled").length,
			disabled: rows.filter(r => r.state === "disabled").length,
			conditional: rows.filter(r => r.state === "conditional").length,
			broken: rows.filter(r => r.pluginIssue !== null).length,
		};
	}, [composition]);

	if (!composition) {
		return (
			<div className="gui-ext-plugins">{error ? <div className="gui-ext-plugins-error">{error}</div> : null}</div>
		);
	}

	// A profile that declares no composition is the ordinary case, not an error
	// state — say what a profile would do to declare one.
	if (composition.declared !== "ok") {
		return (
			<div className="gui-ext-plugins">
				<div className="gui-ext-plugins-toolbar">
					<span className="gui-ext-plugins-toolbar-count">{tLoose("tools.bundleTitle")}</span>
				</div>
				<div className="gui-ext-empty-state">
					<Icon name="plug-2" className="h-5 w-5 opacity-40" />
					<div className="gui-ext-empty-state-title">{tLoose("tools.bundleNoCompositionTitle")}</div>
					<p className="gui-ext-empty-state-desc">
						{composition.declared === "unreadable" ? composition.detail : tLoose("tools.bundleNoCompositionDesc")}
					</p>
				</div>
			</div>
		);
	}

	return (
		<div className="gui-ext-plugins">
			<div className="gui-ext-plugins-toolbar">
				<span className="gui-ext-plugins-toolbar-count">
					{composition.profile ? `${tLoose("tools.bundleProfile")} ${composition.profile} · ` : ""}
					{tLoose("tools.bundleRows", { count: counts.total })}
					{counts.disabled > 0 ? ` · ${tLoose("tools.bundleDisabledCount", { count: counts.disabled })}` : ""}
					{counts.conditional > 0 ? ` · ${tLoose("tools.bundleConditionalCount", { count: counts.conditional })}` : ""}
				</span>
			</div>
			{error && <div className="gui-ext-plugins-error">{error}</div>}
			{composition.unevaluatedExpressions > 0 && (
				<div className="gui-ext-plugins-note">
					<Icon name="alert" className="h-3.5 w-3.5 shrink-0" />
					<span>{tLoose("tools.bundleUnevaluatedHint", { count: composition.unevaluatedExpressions })}</span>
				</div>
			)}
			<div className="gui-ext-list-scroll">
				<div className="gui-ext-group">
					<div className="gui-ext-group-title">
						{tLoose("tools.bundleLayers")} · {composition.layers.length}
					</div>
					{composition.layers.map(layer => (
						<div key={layer.name} className="gui-bundle-layer">
							<span className="gui-bundle-layer-name">{layer.name}</span>
							<span className="gui-ext-item-tag">{tLoose("tools.bundleLayerRows", { count: layer.rows })}</span>
							{layer.overrides > 0 && (
								<span className="gui-ext-item-tag gui-ext-item-tag--preset">
									{tLoose("tools.bundleLayerOverrides", { count: layer.overrides })}
								</span>
							)}
							{layer.unreadable.length > 0 && (
								<span className="gui-ext-item-tag gui-ext-item-tag--err" title={layer.unreadable.join("\n")}>
									{tLoose("tools.bundleLayerUnreadable", { count: layer.unreadable.length })}
								</span>
							)}
						</div>
					))}
				</div>
				{composition.rows.length === 0 ? (
					<div className="gui-ext-empty-state">
						<Icon name="plug" className="h-5 w-5 opacity-40" />
						<div className="gui-ext-empty-state-title">{tLoose("tools.bundleNoRowsTitle")}</div>
						<p className="gui-ext-empty-state-desc">{tLoose("tools.bundleNoRowsDesc")}</p>
					</div>
				) : (
					<div className="gui-ext-group">
						<div className="gui-ext-group-title">{tLoose("tools.bundleRows", { count: composition.rows.length })}</div>
						{composition.rows.map(row => (
							<div key={row.id} className="gui-ext-provider">
								<div className="gui-ext-provider-h">
									<span className="gui-bundle-dot" data-state={row.state} aria-hidden="true" />
									<span className="min-w-0 flex-1 truncate text-[12px] font-medium">{row.id}</span>
									{row.group && <span className="gui-ext-item-tag">{tLoose("tools.bundleGroupTag")}</span>}
									{row.pluginIssue === "not-installed" && (
										<span className="gui-ext-item-tag gui-ext-item-tag--err">
											{tLoose("tools.bundlePluginMissing")}
										</span>
									)}
									{row.pluginIssue === "disabled" && (
										<span className="gui-ext-item-tag">{tLoose("tools.bundlePluginDisabled")}</span>
									)}
									{row.state === "conditional" && (
										<span
											className="gui-ext-item-tag gui-ext-item-tag--gui"
											title={tLoose("tools.bundleConditionalHint")}
										>
											{tLoose("tools.bundleConditionalTag")}
										</span>
									)}
									{row.state !== "conditional" && (
										<button
											type="button"
											role="switch"
											aria-checked={row.state === "enabled"}
											aria-label={`${row.state === "enabled" ? tLoose("tools.disableSkill") : tLoose("tools.enableSkill")} ${row.id}`}
											className={`gui-toggle gui-toggle--sm${row.state === "enabled" ? " gui-toggle--on" : ""}`}
											disabled={busyId !== null}
											onClick={() => toggle(row)}
										>
											<span className="gui-toggle-knob" />
										</button>
									)}
								</div>
								<div className="gui-ext-plugins-meta">
									<span className="gui-bundle-package">{row.name}</span>
									<span className="gui-ext-group-count">{row.layers.join(" · ")}</span>
								</div>
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
