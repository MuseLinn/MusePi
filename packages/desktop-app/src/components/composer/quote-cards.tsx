import type { DisplayContext } from "@musepi/client-core/src/messages/display-context";
import {
	browserAnnotationTargetCount,
	displayContextQuote,
	withDisplayContextComment,
} from "@musepi/client-core/src/messages/display-context";
import { Eye, FileText, Globe2, MessageSquareQuote, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { t } from "../../i18n/index.js";
import { useFloatingMenu } from "../../lib/use-floating-menu";

type ContextEntry = { context: DisplayContext; index: number };
type ContextGroup = {
	kind: DisplayContext["kind"];
	label: string;
	icon: ReactNode;
	entries: ContextEntry[];
};

function fileName(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function QuoteEntry({
	entry,
	preview,
	onPreview,
	onRemove,
	onChange,
}: {
	entry: ContextEntry;
	preview: boolean;
	onPreview(): void;
	onRemove(): void;
	onChange(context: DisplayContext): void;
}): ReactNode {
	const { context } = entry;
	return (
		<div className="gui-quote-card">
			<div className="gui-quote-context-body">
				<div className="gui-quote-context-meta">
					{context.kind === "browser-annotation" ? (
						<>
							<span className="gui-quote-context-page" title={context.pageUrl}>
								{context.pageUrl}
							</span>
							<span className="gui-quote-context-count">{browserAnnotationTargetCount(context)}</span>
						</>
					) : context.kind === "file-quote" ? (
						<>
							<span className="gui-quote-context-page" title={context.path}>
								{fileName(context.path)}
								{context.pdf
									? ` · PDF ${context.pdf.startPage}-${context.pdf.endPage}`
									: context.startLine !== undefined && context.endLine !== undefined
										? `:${context.startLine}-${context.endLine}`
										: ""}
							</span>
							{context.language ? <span className="gui-quote-context-count">{context.language}</span> : null}
						</>
					) : (
						<span className="gui-quote-context-page">{t("general.chatReferences")}</span>
					)}
				</div>
				<div className="gui-quote-context-preview" data-collapsed={!preview}>
					{preview && context.kind === "browser-annotation" && context.image ? (
						<img className="gui-quote-context-image" src={context.image} alt={t("settings.previewImage")} />
					) : null}
					<pre>{displayContextQuote(context)}</pre>
				</div>
				<label className="gui-quote-comment-label">
					<span>{t("annotation.commentLabel")}</span>
					<input
						className="gui-quote-comment"
						value={context.comment ?? ""}
						placeholder={t("annotation.commentPlaceholder")}
						onChange={event => onChange(withDisplayContextComment(context, event.target.value))}
					/>
				</label>
			</div>
			<div className="gui-quote-entry-actions">
				<button
					type="button"
					className="gui-quote-preview"
					onClick={onPreview}
					title={t("general.togglePreview")}
					aria-label={t("general.togglePreview")}
					aria-expanded={preview}
				>
					<Eye size={12} />
				</button>
				<button
					type="button"
					className="gui-quote-close"
					onClick={onRemove}
					title={t("general.removeQuote")}
					aria-label={t("general.removeQuote")}
				>
					<X size={12} />
				</button>
			</div>
		</div>
	);
}

function QuoteGroupChip({
	group,
	open,
	preview,
	onToggle,
	onPreview,
	onRemove,
	onChange,
}: {
	group: ContextGroup;
	open: boolean;
	preview: number | null;
	onToggle(): void;
	onPreview(index: number): void;
	onRemove(index: number): void;
	onChange(index: number, context: DisplayContext): void;
}): ReactNode {
	const menu = useFloatingMenu(open, next => {
		if (!next && open) onToggle();
	});
	return (
		<>
			<button
				ref={menu.anchorRef}
				type="button"
				className="gui-quote-chip"
				data-quote-kind={group.kind}
				aria-haspopup="dialog"
				aria-expanded={open}
				onClick={onToggle}
			>
				{group.icon}
				<span>{group.label}</span>
				<span className="gui-quote-chip-count">{group.entries.length}</span>
			</button>
			{menu.renderMenu(
				<div className="gui-quote-popup" role="dialog" aria-label={group.label}>
					{group.entries.map(entry => (
						<QuoteEntry
							key={entry.index}
							entry={entry}
							preview={preview === entry.index}
							onPreview={() => onPreview(entry.index)}
							onRemove={() => onRemove(entry.index)}
							onChange={context => onChange(entry.index, context)}
						/>
					))}
				</div>,
			)}
		</>
	);
}

export function QuoteCards({
	contexts,
	onRemove,
	onChange,
}: {
	contexts: DisplayContext[];
	onRemove(index: number): void;
	onChange(index: number, context: DisplayContext): void;
}): ReactNode {
	const [openKind, setOpenKind] = useState<DisplayContext["kind"] | null>(null);
	const [preview, setPreview] = useState<number | null>(null);
	const definitions: Array<Pick<ContextGroup, "kind" | "label" | "icon">> = [
		{ kind: "file-quote", label: t("general.fileReferences"), icon: <FileText size={13} /> },
		{ kind: "chat-quote", label: t("general.chatReferences"), icon: <MessageSquareQuote size={13} /> },
		{ kind: "browser-annotation", label: t("general.browserReferences"), icon: <Globe2 size={13} /> },
	];
	const groups = definitions
		.map(definition => ({
			...definition,
			entries: contexts.flatMap((context, index) => (context.kind === definition.kind ? [{ context, index }] : [])),
		}))
		.filter(group => group.entries.length > 0);
	useEffect(() => {
		if (openKind && !contexts.some(context => context.kind === openKind)) {
			setOpenKind(null);
			setPreview(null);
		}
	}, [contexts, openKind]);
	const toggle = (kind: DisplayContext["kind"]): void => {
		setOpenKind(current => (current === kind ? null : kind));
		setPreview(null);
	};
	return (
		<div className="gui-quote-contexts" aria-label={t("settings.quote")}>
			{groups.map(group => (
				<QuoteGroupChip
					key={group.kind}
					group={group}
					open={openKind === group.kind}
					preview={preview}
					onToggle={() => toggle(group.kind)}
					onPreview={index => setPreview(current => (current === index ? null : index))}
					onRemove={index => {
						setPreview(null);
						onRemove(index);
					}}
					onChange={onChange}
				/>
			))}
		</div>
	);
}
