/**
 * 移动端的会话树摘要条:面包屑(根→当前叶)、历史叶上的分叉提示、撤回后的
 * 撤销行。三件事共用一条 —— 手机上分别占一行会把转录挤掉两三行。
 *
 * 条本身在滚动容器之外(见 app.tsx 的 TranscriptPane),滚到任何位置都还
 * 知道"我在树的哪里",所以它不能依赖 `.tr-root` 的排版。
 *
 * 面包屑是否出现由 `shouldShowTreeNav` 决定:线性会话里它就是转录本身,
 * 列在顶上只是把同样的文字重排一遍。
 */
import { ChevronRight, GitFork, Undo2, X } from "lucide-react";
import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import { shouldShowTreeNav, type TreeOutline } from "./tree-outline.js";

/** 面包屑最多显示的段数;更深的链只留最近的几段。 */
const MAX_CRUMBS = 5;

export interface TreeOutlineUndo {
	/** 撤回目标的消息文本(空串时只显示"已回退")。 */
	label: string;
	onUndo(): void;
	onDismiss(): void;
}

export function TreeOutlineNav({
	outline,
	undo = null,
	onJump,
}: {
	outline: TreeOutline;
	undo?: TreeOutlineUndo | null;
	onJump(entryId: string): void;
}): ReactNode {
	const showCrumbs = shouldShowTreeNav(outline);
	if (!showCrumbs && undo === null && !outline.leafIsHistorical) return null;
	const path = outline.path;
	const capped = path.length > MAX_CRUMBS ? path.slice(-MAX_CRUMBS) : path;
	return (
		<div className="tr-tree-outline">
			{undo !== null && (
				<div className="tr-tree-outline-undo" role="region" aria-label={t("general.jumpedBack")}>
					<Undo2 size={13} className="tr-tree-outline-undo-icon" aria-hidden />
					<span className="tr-tree-outline-undo-text" title={undo.label}>
						{undo.label ? `${t("general.jumpedBack2")}: ${undo.label}` : t("general.jumpedBack")}
					</span>
					<button type="button" className="tr-tree-outline-undo-action" onClick={undo.onUndo}>
						{t("general.undo")}
					</button>
					<button
						type="button"
						className="tr-tree-outline-close"
						title={t("settings.dismiss")}
						aria-label={t("settings.dismiss")}
						onClick={undo.onDismiss}
					>
						<X size={12} aria-hidden />
					</button>
				</div>
			)}
			{outline.leafIsHistorical && (
				<div className="tr-tree-outline-hint" role="note">
					<GitFork size={12} aria-hidden />
					<span>
						{t("transcript.willForkNewBranchWithLabel", {
							label: outline.leafLabel || t("transcript.thisNode"),
						})}
					</span>
				</div>
			)}
			{showCrumbs && (
				<nav className="tr-tree-outline-crumbs" aria-label={t("transcript.sessionPath")}>
					{(path.length > MAX_CRUMBS || !outline.complete) && (
						<span className="tr-tree-outline-more" aria-hidden>
							…
						</span>
					)}
					{capped.map((node, i) => (
						<span key={node.id} className="tr-tree-outline-crumb">
							{i > 0 && <ChevronRight size={11} className="tr-tree-outline-sep" aria-hidden />}
							<button
								type="button"
								className={`tr-tree-outline-seg tr-tree-outline-seg--${node.kind}`}
								title={node.label}
								aria-current={i === capped.length - 1 ? "location" : undefined}
								onClick={() => onJump(node.id)}
							>
								{node.label || "…"}
							</button>
						</span>
					))}
				</nav>
			)}
		</div>
	);
}
