/**
 * PluginPackageDialog — the installed-plugin-package detail surface: the big
 * brand icon left, name + version +
 * description, status line, and 卸载 in the header. A package's extension
 * modules render inside here as 包含的组件 rows with their own toggles —
 * NOT as separate list rows (the package is the one list entry), and the
 * package's settings components (slot settings.extensions / settings.item.*
 * whose extensionId lives under the package dir) mount in a 插件设置
 * section, which is where a plugin's own management UI appears.
 *
 * settings.tab.* pages are deliberately excluded: a full settings nav page
 * (its own scrollable multi-section layout) does not fit a dialog — it
 * would render a second copy of the page next to the settings nav entry it
 * already lives in. Detail surfaces get the compact settings.extensions /
 * settings.item.* components instead.
 */
import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useConfirm } from "../lib/prompt-dialog";
import type { RpcClient } from "../lib/rpc";
import {
	ConfigFormSlotMount,
	type ExtensionItem,
	SETTINGS_TAB_SLOT_PREFIX,
	type SlotComponent,
} from "../lib/slot-host";
import { Icon } from "../vendor/oc-icons";
import { DialogFrame } from "./DialogFrame";
import { PluginIcon } from "./PluginIcon";
import { type PluginPackageEntry, sourceLevelLabel } from "./UnifiedPluginsView";

export function PluginPackageDialog({
	open,
	onClose,
	pkg,
	modules,
	components,
	busy,
	uninstalling,
	onUninstall,
	onTogglePackage,
	onToggleModule,
	onError,
	rpc,
}: {
	open: boolean;
	onClose(): void;
	pkg: PluginPackageEntry | null;
	/** The package's extension modules (path under the package dir). */
	modules: ExtensionItem[];
	/** Slot components whose extensionId lives under the package dir. */
	components: SlotComponent[];
	busy: boolean;
	uninstalling: boolean;
	onUninstall(p: PluginPackageEntry): void;
	onTogglePackage(p: PluginPackageEntry): void;
	onToggleModule(e: ExtensionItem): void;
	onError(m: string | null): void;
	rpc: RpcClient | null;
}): ReactNode {
	const { confirm } = useConfirm();
	const settingsComponents = components.filter(
		c => c.slot.startsWith("settings.") && !c.slot.startsWith(SETTINGS_TAB_SLOT_PREFIX),
	);
	// A plugin's own panel persists through settingsScope — the same proxy the
	// settings-page cards receive. Without it a panel that writes settings
	// would see `undefined` where it expects a read/write object.
	const settingsScope = rpc
		? {
				get: (keys: string[]) => rpc.request<Record<string, unknown>>("settings.get", { keys }),
				set: (key: string, value: unknown) => rpc.request("settings.set", { key, value }) as Promise<void>,
			}
		: null;

	const askUninstall = (): void => {
		if (!pkg) return;
		void confirm(t("tools.pluginUninstallConfirm", { name: pkg.name }), t("tools.uninstall")).then(ok => {
			if (ok) onUninstall(pkg);
		});
	};

	return (
		<DialogFrame open={open} onClose={onClose} label={t("tools.extPluginDetails")} className="gui-plugin-dialog">
			{pkg && (
				<>
					<div className="gui-dialog-head">
						<PluginIcon name={pkg.name} icon={pkg.icon} size={34} status={pkg.enabled ? "active" : "off"} />
						<span className="min-w-0 flex-1 truncate text-[14px] font-semibold">{pkg.name}</span>
						<span className="gui-ext-item-tag">{`v${pkg.version}`}</span>
						<button
							type="button"
							className="gui-tool-btn"
							disabled={uninstalling}
							onClick={askUninstall}
							title={t("tools.uninstall")}
							aria-label={`${t("tools.uninstall")} ${pkg.name}`}
						>
							<Icon name="delete-bin" className="h-4 w-4" />
						</button>
						<button type="button" className="gui-tool-btn" onClick={onClose} aria-label={t("settings.close")}>
							<Icon name="close" className="h-4 w-4" />
						</button>
					</div>
					<div className="gui-plugin-dialog-body">
						<div className="gui-ext-detail-section">
							<div className={`gui-ext-detail-status${pkg.enabled ? " gui-ext-detail-status--active" : ""}`}>
								<span className={`gui-ext-dot${pkg.enabled ? "" : " gui-ext-dot--off"}`} />
								{pkg.enabled ? t("tools.pluginStateEnabled") : t("tools.pluginStateDisabled")}
								<span className="gui-ext-item-tag">{sourceLevelLabel("omp-plugins", pkg.scope)}</span>
								<span style={{ marginLeft: "auto" }}>
									<button
										type="button"
										role="switch"
										aria-checked={pkg.enabled}
										aria-label={`${t("tools.pluginEnable")} ${pkg.name}`}
										className={`gui-toggle${pkg.enabled ? " gui-toggle--on" : ""}`}
										disabled={busy}
										onClick={() => onTogglePackage(pkg)}
									>
										<span className="gui-toggle-knob" />
									</button>
								</span>
							</div>
							{pkg.description ? <div className="gui-ext-plugins-desc">{pkg.description}</div> : null}
						</div>
						{pkg.tools > 0 || pkg.commands > 0 || pkg.handlers > 0 ? (
							<div className="gui-ext-plugins-meta">
								<span className="gui-ext-group-count">
									{t("tools.pluginCounts", {
										tools: pkg.tools,
										commands: pkg.commands,
										handlers: pkg.handlers,
									})}
								</span>
							</div>
						) : null}
						{modules.length > 0 && (
							<div className="gui-ext-detail-section">
								<div className="gui-ext-detail-label">
									{t("tools.extIncludedComponents")} · {modules.length}
								</div>
								{modules.map(m => (
									<div key={m.id} className="gui-ext-provider-h">
										<code className="min-w-0 flex-1 truncate">{m.displayName || m.name}</code>
										<span
											className={`gui-ext-dot${m.loadError ? " gui-ext-dot--error" : m.state === "active" ? "" : " gui-ext-dot--off"}`}
										/>
										{m.loadError ? (
											<span className="gui-ext-item-tag gui-ext-item-tag--err">
												{t("tools.extLoadFailed")}
											</span>
										) : null}
										<span style={{ marginLeft: "auto" }}>
											<button
												type="button"
												role="switch"
												aria-checked={m.state === "active"}
												aria-label={`${m.state === "active" ? t("tools.disableSkill") : t("tools.enableSkill")} ${m.displayName || m.name}`}
												className={`gui-toggle gui-toggle--sm${m.state === "active" ? " gui-toggle--on" : ""}`}
												disabled={busy}
												onClick={() => onToggleModule(m)}
											>
												<span className="gui-toggle-knob" />
											</button>
										</span>
									</div>
								))}
							</div>
						)}
						{settingsComponents.length > 0 && (
							<div className="gui-ext-detail-section">
								<div className="gui-ext-detail-label">{t("tools.pluginSettingsSection")}</div>
								{settingsComponents.map(item => (
									<ConfigFormSlotMount
										key={`${item.slot}:${item.extensionId}`}
										item={item}
										rpc={rpc}
										settingsScope={settingsScope}
									/>
								))}
							</div>
						)}
					</div>
				</>
			)}
		</DialogFrame>
	);
}
