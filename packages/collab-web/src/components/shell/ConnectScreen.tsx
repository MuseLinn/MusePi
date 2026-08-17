import type { FormEvent, ReactNode } from "react";
import { useState } from "react";
import { t } from "../../i18n/index.js";
import { LanguageToggle } from "./LanguageToggle";
import { ThemeToggle } from "./ThemeToggle";
import { AccentToggle } from "./AccentToggle";

export interface ConnectScreenProps {
	defaultName: string;
	/** Deep-link fragment (a full collab link) pre-fills the input so a failed auto-connect still shows what to join. */
	defaultLink?: string;
	error: string | null;
	onConnect(link: string, name: string): void;
}

export function ConnectScreen({ defaultName, defaultLink, error, onConnect }: ConnectScreenProps): ReactNode {
	const [link, setLink] = useState(defaultLink ?? "");
	const [name, setName] = useState(defaultName);
	const [localError, setLocalError] = useState<string | null>(null);

	const submit = (e: FormEvent<HTMLFormElement>): void => {
		e.preventDefault();
		const trimmed = link.trim();
		if (!trimmed) {
			setLocalError(t("paste a join link first"));
			return;
		}
		setLocalError(null);
		onConnect(trimmed, name.trim() || t("guest"));
	};

	const shown = localError ?? error;

	return (
		<div className="sh-connect">
			<form className="sh-connect-card" onSubmit={submit}>
				<div className="sh-connect-head">
					<div className="sh-lockup">
						<span className="sh-lockup-mark" aria-hidden="true" />
						<span className="sh-lockup-pi">π</span> {t("musepi collab")}
					</div>
					<ThemeToggle />
					<AccentToggle />
					<LanguageToggle />
				</div>
				<div className="sh-connect-sub">{t("live agent session, in your browser")}</div>
				<label className="sh-field">
					<span className="sh-field-label">{t("join link")}</span>
					<input
						className="sh-input sh-input-mono"
						type="text"
						value={link}
						onChange={e => setLink(e.target.value)}
						placeholder={t("ws://host:port/r/room.key")}
						spellCheck={false}
						autoComplete="off"
						autoFocus
					/>
					<span className="sh-field-hint">{t("paste a /collab link from any musepi session")}</span>
				</label>
				<label className="sh-field">
					<span className="sh-field-label">{t("display name")}</span>
					<input
						className="sh-input"
						type="text"
						value={name}
						onChange={e => setName(e.target.value)}
						placeholder={t("guest")}
						spellCheck={false}
						autoComplete="off"
						maxLength={32}
					/>
				</label>
				{shown && <div className="sh-connect-error">{shown}</div>}
				<button className="sh-btn sh-btn-primary sh-connect-submit" type="submit">
					{t("Connect")}
				</button>
			</form>
		</div>
	);
}
