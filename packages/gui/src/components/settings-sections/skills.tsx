import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import type { RpcClient } from "../../lib/rpc";
import { ExtensionsCenter } from "../ExtensionsCenter";

/** Settings → 智能体 → 技能: discovered skills (daemon skills.list). */
/** Settings → 智能体 → 技能: 扩展控制中心 (CCEC 形态) — provider tabs +
 *  categorized list + detail pane over skills + context files. The section
 *  fills the settings viewport (gui-skills-section height:100%) so the
 *  center's two panes scroll internally instead of the whole page —
 *  TUI /extensions panel parity. */
export function SkillsSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	return (
		<div className="gui-skills-section">
			<h2 className="gui-settings-page-title">{t("extensions control center")}</h2>
			<p className="gui-settings-page-desc">{t("extensions settings")}</p>
			<ExtensionsCenter rpc={rpc} />
		</div>
	);
}
