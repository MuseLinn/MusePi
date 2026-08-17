import { type TranslationKey, t } from "@musepi/desktop-web";
import type { ReactElement } from "react";
import { Icon } from "../vendor/oc-icons";
import { slashDisplayName } from "./slash-row-shared";

/**
 * Slash-command completion row (openchamber-style rich menu): first line
 * carries the command name, subcommand hints and two category badges
 * (kind + scope); the second line shows the description. Shared by the
 * session Composer and the WelcomeComposer so both / menus stay in sync.
 */
export interface SlashEntry {
	name: string;
	description?: string;
	subcommands?: { name: string }[];
	kind?: "command" | "skill";
	category?: string;
}

export function SlashRow({
	item,
	active,
	onClick,
}: {
	item: SlashEntry;
	active: boolean;
	onClick: () => void;
}): ReactElement {
	const isSkill = item.kind === "skill";
	const display = slashDisplayName(item);
	const kindLabel = isSkill ? t("skills") : t("command");
	const categoryLabel = t(`tag.${item.category ?? "system"}` as TranslationKey);
	return (
		<button
			type="button"
			className={`gui-slash-row${active ? " gui-slash-row--active" : ""}`}
			onMouseDown={ev => ev.preventDefault()}
			onClick={onClick}
		>
			<span className={`gui-slash-row-icon${isSkill ? " gui-slash-row-icon--skill" : ""}`}>
				<Icon name={isSkill ? "lightbulb" : "command"} className="h-4 w-4" />
			</span>
			<span className="gui-slash-row-body">
				<span className="gui-slash-row-line1">
					<span className="gui-slash-row-name">/{display}</span>
					{item.subcommands && item.subcommands.length > 0 && (
						<span className="gui-slash-row-sub">
							{item.subcommands
								.slice(0, 3)
								.map(sc => sc.name)
								.join(" · ")}
						</span>
					)}
					<span className="gui-slash-row-tags">
						<span className={`gui-tag${isSkill ? " gui-tag--skill" : " gui-tag--cmd"}`}>{kindLabel}</span>
						<span className="gui-tag gui-tag--cat">{categoryLabel}</span>
					</span>
				</span>
				{item.description ? <span className="gui-slash-row-desc">{item.description}</span> : null}
			</span>
		</button>
	);
}
