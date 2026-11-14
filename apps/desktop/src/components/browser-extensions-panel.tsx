import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RpcClient } from "../lib/rpc";
import { Icon } from "../vendor/oc-icons";

interface BrowserExtensionInfo {
	id: string;
	name: string;
	version: string;
}

interface RelayStatus {
	installed: boolean;
	serving: boolean;
	connected: boolean;
	extensionDir: string;
}

function relayStatusText(status: RelayStatus | null): string {
	if (status === null) return t("tools.browserRelayExtensionDescription");
	if (!status.installed) return t("tools.browserRelayExtensionDescription");
	if (status.connected) return t("tools.browserRelayConnected");
	if (status.serving) return t("tools.browserRelayServingWaiting");
	return t("tools.browserRelayInstalledNot");
}

export function BrowserExtensionsPanel({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [relay, setRelay] = useState<RelayStatus | null>(null);
	const [extensions, setExtensions] = useState<BrowserExtensionInfo[] | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const alive = useRef(true);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);

	const refresh = useCallback(async (): Promise<void> => {
		if (!rpc) {
			setRelay(null);
			setExtensions([]);
			return;
		}
		const [relayResult, extensionsResult] = await Promise.allSettled([
			rpc.request<RelayStatus>("browser.relayStatus", {}),
			rpc.request<{ extensions?: BrowserExtensionInfo[]; profileDir?: string }>("browser.extensions", {}),
		]);
		if (!alive.current) return;
		setRelay(relayResult.status === "fulfilled" ? relayResult.value : null);
		setExtensions(extensionsResult.status === "fulfilled" ? (extensionsResult.value.extensions ?? []) : []);
		const failure = [relayResult, extensionsResult].find(result => result.status === "rejected");
		setError(failure?.status === "rejected" ? String(failure.reason) : null);
	}, [rpc]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const changeRelay = async (action: "install" | "uninstall"): Promise<void> => {
		if (!rpc || busy) return;
		setBusy(true);
		setError(null);
		try {
			await rpc.request(action === "install" ? "browser.relayInstall" : "browser.relayUninstall", {});
			await refresh();
		} catch (reason) {
			if (alive.current) setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			if (alive.current) setBusy(false);
		}
	};

	return (
		<div className="gui-browser-extensions">
			<section className="gui-browser-extension-group" aria-label={t("tools.browserRelayExtension")}>
				<div className="gui-browser-extension-heading">{t("tools.browserRelayExtension")}</div>
				<div className="gui-browser-extension-row">
					<span className="gui-browser-extension-icon" aria-hidden>
						<Icon name="plug" className="h-4 w-4" />
					</span>
					<div className="gui-browser-extension-copy">
						<div className="gui-browser-extension-name">{t("tools.browserRelay")}</div>
						<div className="gui-browser-extension-description">{relayStatusText(relay)}</div>
					</div>
					<button
						type="button"
						className={`gui-btn gui-btn--small${relay?.installed ? " gui-btn--danger" : ""}`}
						disabled={!rpc || busy}
						onClick={() => void changeRelay(relay?.installed ? "uninstall" : "install")}
					>
						{busy ? "…" : relay?.installed ? t("tools.uninstall") : t("tools.install")}
					</button>
				</div>
			</section>
			<section className="gui-browser-extension-group" aria-label={t("tools.sharedChromium")}>
				<div className="gui-browser-extension-heading">{t("tools.sharedChromium")}</div>
				<div className="gui-browser-extension-group-desc">{t("tools.sharedChromiumExtensionsDescription")}</div>
				{extensions === null ? (
					<div className="gui-browser-extension-empty" role="status">
						{t("tools.loadingExtensions")}
					</div>
				) : extensions.length === 0 ? (
					<div className="gui-browser-extension-empty">{t("tools.noExtensions")}</div>
				) : (
					<div className="gui-browser-extension-list">
						{extensions.map(extension => (
							<div key={extension.id} className="gui-browser-extension-row">
								<span className="gui-browser-extension-icon" aria-hidden>
									<Icon name="apps-2-ai" className="h-4 w-4" />
								</span>
								<div className="gui-browser-extension-copy">
									<div className="gui-browser-extension-name">{extension.name}</div>
									<div className="gui-browser-extension-description">{extension.id}</div>
								</div>
								<span className="gui-provider-chip">{extension.version}</span>
							</div>
						))}
					</div>
				)}
			</section>
			{error ? (
				<div className="gui-browser-extension-error" role="alert">
					{error}
				</div>
			) : null}
		</div>
	);
}
