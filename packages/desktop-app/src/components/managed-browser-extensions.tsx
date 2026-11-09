import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../vendor/oc-icons";

export function ManagedBrowserExtensions(): ReactNode {
	const [extensions, setExtensions] = useState<ManagedExtensionInfo[] | null>(null);
	const [errors, setErrors] = useState<string[]>([]);
	const [candidate, setCandidate] = useState<ManagedExtensionCandidate | null>(null);
	const [busy, setBusy] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const alive = useRef(true);
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
		};
	}, []);

	const refresh = useCallback(async (): Promise<void> => {
		const api = window.electronAPI;
		if (!api?.managedBrowserExtensionsList) {
			setExtensions([]);
			return;
		}
		try {
			const result = await api.managedBrowserExtensionsList();
			if (!alive.current) return;
			setExtensions(result.extensions);
			setErrors(result.errors);
		} catch (error) {
			if (!alive.current) return;
			setExtensions([]);
			setActionError(error instanceof Error ? error.message : String(error));
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const choose = async (): Promise<void> => {
		const api = window.electronAPI;
		if (!api?.managedBrowserExtensionsChoose || busy) return;
		setBusy(true);
		setActionError(null);
		try {
			const result = await api.managedBrowserExtensionsChoose();
			if (alive.current && result.candidate) setCandidate(result.candidate);
		} catch (error) {
			if (alive.current) setActionError(error instanceof Error ? error.message : String(error));
		} finally {
			if (alive.current) setBusy(false);
		}
	};

	const install = async (): Promise<void> => {
		const api = window.electronAPI;
		if (!api?.managedBrowserExtensionsInstall || busy) return;
		setBusy(true);
		setActionError(null);
		try {
			await api.managedBrowserExtensionsInstall({ confirmed: true });
			if (!alive.current) return;
			setCandidate(null);
			await refresh();
		} catch (error) {
			if (alive.current) setActionError(error instanceof Error ? error.message : String(error));
		} finally {
			if (alive.current) setBusy(false);
		}
	};

	const remove = async (id: string): Promise<void> => {
		const api = window.electronAPI;
		if (!api?.managedBrowserExtensionsRemove || busy) return;
		setBusy(true);
		setActionError(null);
		try {
			await api.managedBrowserExtensionsRemove({ id });
			await refresh();
		} catch (error) {
			if (alive.current) setActionError(error instanceof Error ? error.message : String(error));
		} finally {
			if (alive.current) setBusy(false);
		}
	};

	return (
		<div className="gui-browser-extensions">
			<div className="gui-browser-extension-group">
				<div className="gui-browser-extension-row">
					<span className="gui-browser-extension-icon" aria-hidden>
						<Icon name="apps-2-ai" className="h-4 w-4" />
					</span>
					<div className="gui-browser-extension-copy">
						<div className="gui-browser-extension-name">{t("tools.managedBrowserExtensions")}</div>
						<div className="gui-browser-extension-description">
							{t("tools.managedBrowserExtensionsDescription")}
						</div>
					</div>
					<button type="button" className="gui-btn gui-btn--small" disabled={busy} onClick={() => void choose()}>
						{t("tools.managedBrowserInstallUnpacked")}
					</button>
				</div>
			</div>
			{candidate ? (
				<div className="gui-browser-extension-group" aria-label={t("tools.managedBrowserPermissions")}>
					<div className="gui-browser-extension-heading">{candidate.name}</div>
					<div className="gui-browser-extension-group-desc">{candidate.version}</div>
					<div className="gui-browser-extension-group-desc">{t("tools.managedBrowserPermissions")}</div>
					<div className="gui-browser-extension-permissions">
						{candidate.permissions.length > 0
							? candidate.permissions.map(permission => (
									<span key={permission} className="gui-provider-chip">
										{permission}
									</span>
								))
							: t("tools.managedBrowserNoPermissions")}
					</div>
					<div className="gui-browser-import-actions">
						<button
							type="button"
							className="gui-btn gui-btn--small"
							disabled={busy}
							onClick={() => void install()}
						>
							{t("tools.install")}
						</button>
						<button
							type="button"
							className="gui-btn gui-btn--small"
							disabled={busy}
							onClick={() => setCandidate(null)}
						>
							{t("tools.canceled")}
						</button>
					</div>
				</div>
			) : null}
			<div className="gui-browser-extension-group">
				{extensions === null ? (
					<div className="gui-browser-extension-empty" role="status">
						{t("tools.loadingExtensions")}
					</div>
				) : extensions.length === 0 ? (
					<div className="gui-browser-extension-empty">{t("tools.managedBrowserNoExtensions")}</div>
				) : (
					<div className="gui-browser-extension-list">
						{extensions.map(extension => (
							<div key={extension.id} className="gui-browser-extension-row">
								<span className="gui-browser-extension-icon" aria-hidden>
									<Icon name="apps-2-ai" className="h-4 w-4" />
								</span>
								<div className="gui-browser-extension-copy">
									<div className="gui-browser-extension-name">{extension.name}</div>
									<div className="gui-browser-extension-description">{extension.version}</div>
								</div>
								<button
									type="button"
									className="gui-btn gui-btn--small gui-btn--danger"
									disabled={busy}
									onClick={() => void remove(extension.id)}
								>
									{t("tools.uninstall")}
								</button>
							</div>
						))}
					</div>
				)}
			</div>
			{errors.map(error => (
				<div key={error} className="gui-browser-extension-error" role="alert">
					{error}
				</div>
			))}
			{actionError ? (
				<div className="gui-browser-extension-error" role="alert">
					{actionError}
				</div>
			) : null}
		</div>
	);
}
