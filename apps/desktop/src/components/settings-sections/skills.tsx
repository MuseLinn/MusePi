import type { ReactNode } from "react";
import type { RpcClient } from "../../lib/rpc";
import { ExtensionsCenter } from "../ExtensionsCenter";

/** Settings → 智能体 → 技能: 扩展控制中心 (CCEC 形态) — provider tabs +
 *  categorized list + detail pane over skills + context files. The section
 *  fills the settings viewport (gui-skills-section height:100%) so the
 *  center's two panes scroll internally instead of the whole page —
 *  TUI /extensions panel parity.
 *
 *  No page-level h2 here: ExtensionsCenter renders its own title block
 *  (标题 + 副标题 + 槽位挂载胶囊, 设计稿 2:1427) — a second「扩展控制中心」
 *  heading stacked on top of it read as a duplication bug. */
export function SkillsSection({ rpc }: { rpc: RpcClient | null }): ReactNode {
	return (
		<div className="gui-skills-section">
			<ExtensionsCenter rpc={rpc} />
		</div>
	);
}
