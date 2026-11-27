import { t } from "@musepi/client-core";
import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../vendor/oc-icons";

/**
 * Secret request contract (tower-pinned for M35; M34 implements the daemon
 * side): the daemon pushes `secret-request`, the card answers with
 * `secret.answer`. The value travels one way and is never echoed back — it
 * exists only in this component's input state until the answer is sent.
 *
 * TODO(M34): re-export these from the wire package once it publishes them.
 */
export interface SecretRequest {
	requestId: string;
	name: string;
	purpose: string;
	/**
	 * `fill` asks for a new value, `allow` re-confirms an already saved one,
	 * and `login` asks for a website sign-in the agent will only ever fill.
	 */
	kind: "fill" | "allow" | "login";
	/** How the value will reach the agent: env var or a private file. */
	delivery?: "env" | "file";
	/** For `login`: the site the agent is on, prefilled in the form. */
	site?: string;
}

type SecretAction = "save" | "allow" | "cancel";

/** Every session, or only the asking session's workspace. */
type SecretScopeChoice = "all" | "workspace";

export interface SecretAnswer {
	requestId: string;
	action: SecretAction;
	value?: string;
	/** Chosen scope for `save`; `allow` uses the request's own workspace. */
	scope?: SecretScopeChoice;
	/** For a login card: the sign-in the form collected. */
	login?: {
		site: string;
		username: string;
		totp?: string;
	};
}

/** Values this short are redacted only where they stand alone; the card holds
 *  the store's floor so a saved value is never rejected after the fact. */
const MIN_SECRET_VALUE_LENGTH = 4;

/** How long the one-line outcome stays before the host drops the request. */
const SETTLED_LINGER_MS = 2400;

/** Flush-left with the composer column: overrides the ask card's inset. */
const CARD_STYLE: CSSProperties = { width: "100%", maxWidth: 460, marginLeft: 0 };

/** Hide the glyphs in WebKit through the vendor property. Written as a style
 *  attribute because CSS declaration objects may drop the vendor property;
 *  the field is also a real password input so engines without it still mask.
 *  Autofill opt-outs below keep password managers from offering it. */
const maskStyleRef = (el: HTMLInputElement | null): void => {
	el?.setAttribute("style", "-webkit-text-security: disc");
};

function envVarName(name: string): string {
	return `$MUSEPI_SECRET_${name}`;
}

/**
 * Secret request card, hosted beside the ask/approval cards above the
 * composer. Two shapes:
 * - fill: masked value input, scope note, save/cancel.
 * - allow: the name is already stored; allow/cancel only, no input.
 *
 * The resolved state collapses to one line ("saved"/"allowed"/"cancelled")
 * and the host clears the request after a short linger. Failures show only
 * the daemon's message and keep the input masked for a retry.
 */
export function SecretCard({
	request,
	onAnswer,
	onSettled,
}: {
	request: SecretRequest;
	/** Resolves after the daemon accepts the answer; rejects with an Error
	 *  whose message is shown verbatim. */
	onAnswer(answer: SecretAnswer): Promise<void>;
	/** Called once the outcome line has been shown — the host clears it. */
	onSettled?(requestId: string): void;
}): ReactNode {
	const [value, setValue] = useState("");
	const [scope, setScope] = useState<SecretScopeChoice>("all");
	// Login-only fields: the site, the username and an optional setup key. The
	// password travels in `value`, so it shares the same clear-on-submit path.
	const [loginSite, setLoginSite] = useState(request.site ?? "");
	const [loginUsername, setLoginUsername] = useState("");
	const [loginTotp, setLoginTotp] = useState("");
	// Off by default, like the site-wide match it opts out of: a login fills on
	// the site's sign-in hosts unless the user names exactly one.
	const [loginExactHost, setLoginExactHost] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [settled, setSettled] = useState<SecretAction | null>(null);
	// onSettled identity changes every parent render; bind once via ref so
	// the linger timer never fires a stale callback.
	const onSettledRef = useRef(onSettled);
	onSettledRef.current = onSettled;
	const busyRef = useRef(busy);
	busyRef.current = busy;

	// A fresh request starts clean — never carry a previous value over.
	useEffect(() => {
		setValue("");
		setScope("all");
		setLoginSite(request.site ?? "");
		setLoginUsername("");
		setLoginTotp("");
		setBusy(false);
		setError("");
		setSettled(null);
	}, [request.requestId, request.site]);

	useEffect(() => {
		if (!settled) return;
		const timer = window.setTimeout(() => onSettledRef.current?.(request.requestId), SETTLED_LINGER_MS);
		return () => window.clearTimeout(timer);
	}, [settled, request.requestId]);

	const submit = async (action: SecretAction): Promise<void> => {
		if (busyRef.current) return;
		busyRef.current = true;
		setBusy(true);
		setError("");
		const answer: SecretAnswer = { requestId: request.requestId, action };
		if (action === "save") {
			answer.value = value;
			answer.scope = scope;
			if (request.kind === "login") {
				answer.login = {
					site: loginSite.trim(),
					username: loginUsername.trim(),
					// The checked box narrows matching to the site itself; the host
					// list is what the store compares against.
					...(loginExactHost ? { exactHost: true, hosts: [loginSite.trim().toLowerCase()] } : {}),
					...(loginTotp.trim() ? { totp: loginTotp.trim() } : {}),
				};
			}
		}
		try {
			await onAnswer(answer);
			// Drop the value from component state as soon as the daemon has
			// accepted it — the transcript, stores and logs never see it.
			setValue("");
			setSettled(action);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			busyRef.current = false;
			setBusy(false);
		}
	};

	const cancel = (): void => {
		if (!busyRef.current) void submit("cancel");
	};

	if (settled) {
		const line =
			settled === "save"
				? t("tools.secretSavedLine", { name: request.name })
				: settled === "allow"
					? t("tools.secretAllowedLine", { name: request.name })
					: t("tools.secretCancelledLine");
		return (
			<div className="gui-approval-wrap">
				<div
					className="gui-ask-card gui-ask-card--entered gui-secret-card gui-secret-card--settled"
					style={CARD_STYLE}
					role="status"
					aria-live="polite"
				>
					<div className="gui-ask-card-head">
						<Icon
							name={settled === "cancel" ? "close" : settled === "save" ? "lock" : "key"}
							className="h-3.5 w-3.5 flex-none opacity-70"
						/>
						<span className="gui-ask-card-title">{line}</span>
					</div>
				</div>
			</div>
		);
	}

	const isLogin = request.kind === "login";
	// A login is a fill card: it collects fields rather than confirming an
	// existing entry. Without this the whole login branch fell through to the
	// `allow` card, which even named an environment variable it has no use for.
	const isFill = request.kind === "fill" || isLogin;
	const envVar = envVarName(request.name);
	const scopeNote = !isFill
		? t("tools.secretAllowWorkspace")
		: isLogin
			? t("tools.loginScopeNote")
			: scope === "all"
				? t("tools.secretScopeAll")
				: t("tools.secretScopeWorkspaceNote");
	const tooShort = value.length > 0 && value.length < MIN_SECRET_VALUE_LENGTH;
	const canSave = !tooShort && value.length >= MIN_SECRET_VALUE_LENGTH && !busy;

	const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
		// Escape pressed inside the value field cancels the card and keeps the
		// key away from the turn-interrupt handler. Cards without a field
		// (allow) have no local Escape binding.
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			cancel();
			return;
		}
		if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			if (isFill && canSave) void submit("save");
		}
	};

	return (
		<div className="gui-approval-wrap">
			<div
				className="gui-ask-card gui-ask-card--entered gui-secret-card"
				style={CARD_STYLE}
				role="group"
				aria-label={
					isFill
						? t(request.kind === "login" ? "tools.loginTitle" : "tools.secretTitle")
						: t("tools.secretAllowTitle")
				}
			>
				<div className="gui-ask-card-head">
					<Icon name="key" className="h-3.5 w-3.5 flex-none opacity-70" />
					<span className="gui-ask-card-title">
						{isFill
							? t(request.kind === "login" ? "tools.loginTitle" : "tools.secretTitle")
							: t("tools.secretAllowTitle")}
					</span>
					<button
						type="button"
						className="gui-ask-card-x"
						aria-label={t("settings.cancel")}
						title={t("settings.cancel")}
						disabled={busy}
						onClick={cancel}
					>
						<Icon name="close" className="h-3 w-3" />
					</button>
				</div>
				<p className="gui-note">{request.purpose}</p>
				{isLogin ? (
					<>
						<label className="gui-secret-field">
							<span className="gui-secret-field-label">{t("tools.loginSite")}</span>
							<input
								className="gui-input w-full"
								value={loginSite}
								placeholder={t("tools.loginSitePlaceholder")}
								spellCheck={false}
								disabled={busy}
								onChange={e => setLoginSite(e.target.value)}
							/>
							<span className="gui-secret-field-hint">{t("tools.loginSiteHint")}</span>
						</label>
						<label className="gui-secret-check">
							<input
								type="checkbox"
								checked={loginExactHost}
								disabled={busy}
								onChange={e => setLoginExactHost(e.target.checked)}
							/>
							<span>{t("tools.loginExactHost")}</span>
						</label>
						<label className="gui-secret-field">
							<span className="gui-secret-field-label">{t("tools.loginUsername")}</span>
							<input
								className="gui-input w-full"
								value={loginUsername}
								placeholder={t("tools.loginUsernamePlaceholder")}
								autoComplete="off"
								disabled={busy}
								onChange={e => setLoginUsername(e.target.value)}
							/>
						</label>
						<label className="gui-secret-field">
							<span className="gui-secret-field-label">{t("tools.loginPassword")}</span>
							<input
								ref={maskStyleRef}
								className="gui-input w-full"
								type="password"
								value={value}
								placeholder={t("tools.loginPasswordPlaceholder")}
								autoComplete="off"
								autoCorrect="off"
								autoCapitalize="off"
								spellCheck={false}
								data-1p-ignore=""
								data-lpignore="true"
								data-bwignore="true"
								disabled={busy}
								onChange={e => setValue(e.target.value)}
								onKeyDown={onKeyDown}
							/>
							<span className={tooShort ? "gui-error" : "gui-secret-field-hint"}>
								{t("tools.secretMinLength", { count: MIN_SECRET_VALUE_LENGTH })}
							</span>
						</label>
						<label className="gui-secret-field">
							<span className="gui-secret-field-label">{t("tools.loginTotp")}</span>
							<input
								className="gui-input w-full"
								value={loginTotp}
								placeholder={t("tools.loginTotpPlaceholder")}
								autoComplete="off"
								spellCheck={false}
								disabled={busy}
								onChange={e => setLoginTotp(e.target.value)}
							/>
							<span className="gui-secret-field-hint">{t("tools.loginTotpHint")}</span>
						</label>
					</>
				) : null}
				{isFill && !isLogin ? (
					<>
						<input
							ref={maskStyleRef}
							className="gui-input w-full"
							type="password"
							value={value}
							placeholder={t("tools.secretValuePlaceholder")}
							aria-label={t("tools.secretValuePlaceholder")}
							autoComplete="off"
							autoCorrect="off"
							autoCapitalize="off"
							spellCheck={false}
							data-1p-ignore=""
							data-lpignore="true"
							data-bwignore="true"
							disabled={busy}
							onChange={e => setValue(e.target.value)}
							onKeyDown={onKeyDown}
						/>
						<p className={tooShort ? "gui-error" : "gui-note"}>
							{t("tools.secretMinLength", { count: MIN_SECRET_VALUE_LENGTH })}
						</p>
						<p className="gui-note">{t("tools.secretHiddenNote", { env: envVar })}</p>
					</>
				) : isLogin ? null : (
					<p className="gui-note">{t("tools.secretAlreadySaved", { env: envVar })}</p>
				)}
				{isFill ? (
					<>
						<span className="gui-secret-scope-label">
							{isLogin ? t("tools.loginScope") : t("tools.secretScope")}
						</span>
						<div
							className="gui-secret-scope"
							role="radiogroup"
							aria-label={isLogin ? t("tools.loginScope") : t("tools.secretScope")}
						>
							<button
								type="button"
								role="radio"
								aria-checked={scope === "workspace"}
								className={`gui-btn${scope === "workspace" ? " gui-btn-primary" : ""}`}
								disabled={busy}
								onClick={() => setScope("workspace")}
							>
								{t("tools.secretScopeWorkspace")}
							</button>
							<button
								type="button"
								role="radio"
								aria-checked={scope === "all"}
								className={`gui-btn${scope === "all" ? " gui-btn-primary" : ""}`}
								disabled={busy}
								onClick={() => setScope("all")}
							>
								{t("tools.secretScopeAllSessions")}
							</button>
						</div>
					</>
				) : null}
				<p className="gui-note">{scopeNote}</p>
				{isFill && !isLogin && request.delivery === "file" ? (
					<p className="gui-note">{t("tools.secretFileNote")}</p>
				) : null}
				{error ? (
					<p className="gui-error" role="alert">
						{error}
					</p>
				) : null}
				<div className="gui-ask-summary-actions">
					<button type="button" className="gui-btn" disabled={busy} onClick={cancel}>
						{t("settings.cancel")}
					</button>
					{isFill ? (
						<button
							type="button"
							className="gui-btn gui-btn-primary"
							disabled={!canSave}
							onClick={() => void submit("save")}
						>
							{busy ? t("tools.secretSaving") : isLogin ? t("tools.loginSave") : t("tools.secretSave")}
						</button>
					) : (
						<button
							type="button"
							className="gui-btn gui-btn-primary"
							disabled={busy}
							onClick={() => void submit("allow")}
						>
							{busy ? t("tools.secretAllowing") : t("tools.secretAllow")}
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
