import { Camera, FileText, Globe, ListChecks, MessageSquareWarning, MousePointerClick } from "lucide-react";
import type { ReactNode } from "react";
import { t } from "../../i18n/index.js";
import type { ToolRenderProps } from "../types";
import { detailsRecord, homePath, isRecord, str } from "../util";

interface StructuredDetails {
	status?: Record<string, unknown>;
	pageText?: Record<string, unknown>;
	pageScreenshot?: Record<string, unknown>;
	elementsSnapshot?: Record<string, unknown>;
	visualSnapshot?: Record<string, unknown>;
	visualCrop?: Record<string, unknown>;
	deviceProfiles?: Record<string, unknown>[];
	deviceConfiguration?: Record<string, unknown>;
	history?: Record<string, unknown>[];
	downloads?: Record<string, unknown>[];
	navigation?: Record<string, unknown>;
	waitResult?: Record<string, unknown>;
	visualInteraction?: Record<string, unknown>;
	actionReceipt?: Record<string, unknown>;
	pendingDialogs?: Record<string, unknown>[];
	handledDialogs?: Record<string, unknown>[];
	control?: Record<string, unknown>;
	result?: string;
}

export function browserStructuredOf(result: ToolRenderProps["result"]): StructuredDetails | null {
	const details = detailsRecord(result);
	if (!details) return null;
	const structured = {
		...(isRecord(details.status) ? { status: details.status } : {}),
		...(isRecord(details.pageText) ? { pageText: details.pageText } : {}),
		...(isRecord(details.pageScreenshot) ? { pageScreenshot: details.pageScreenshot } : {}),
		...(isRecord(details.elementsSnapshot) ? { elementsSnapshot: details.elementsSnapshot } : {}),
		...(isRecord(details.visualSnapshot) ? { visualSnapshot: details.visualSnapshot } : {}),
		...(isRecord(details.visualCrop) ? { visualCrop: details.visualCrop } : {}),
		...(Array.isArray(details.deviceProfiles) ? { deviceProfiles: details.deviceProfiles.filter(isRecord) } : {}),
		...(isRecord(details.deviceConfiguration) ? { deviceConfiguration: details.deviceConfiguration } : {}),
		...(Array.isArray(details.history) ? { history: details.history.filter(isRecord) } : {}),
		...(Array.isArray(details.downloads) ? { downloads: details.downloads.filter(isRecord) } : {}),
		...(isRecord(details.navigation) ? { navigation: details.navigation } : {}),
		...(isRecord(details.waitResult) ? { waitResult: details.waitResult } : {}),
		...(isRecord(details.visualInteraction) ? { visualInteraction: details.visualInteraction } : {}),
		...(isRecord(details.actionReceipt) ? { actionReceipt: details.actionReceipt } : {}),
		...(Array.isArray(details.pendingDialogs) ? { pendingDialogs: details.pendingDialogs.filter(isRecord) } : {}),
		...(Array.isArray(details.handledDialogs) ? { handledDialogs: details.handledDialogs.filter(isRecord) } : {}),
		...(isRecord(details.control) ? { control: details.control } : {}),
		...(str(details.result) !== null ? { result: str(details.result)! } : {}),
	};
	return structured.status ||
		structured.pageText ||
		structured.pageScreenshot ||
		structured.elementsSnapshot ||
		structured.visualSnapshot ||
		structured.visualCrop ||
		structured.deviceProfiles ||
		structured.deviceConfiguration ||
		structured.history ||
		structured.downloads ||
		structured.navigation ||
		structured.waitResult ||
		structured.visualInteraction ||
		structured.actionReceipt ||
		structured.pendingDialogs ||
		structured.handledDialogs ||
		structured.control
		? structured
		: null;
}

function bool(value: unknown): string {
	if (value === true) return t("tools.browserYes");
	if (value === false) return t("tools.browserNo");
	return t("tools.browserUnknown");
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): ReactNode {
	return (
		<div className="tv-browser-state-row">
			<span className="tv-browser-state-label">{label}</span>
			<span className={mono ? "tv-browser-state-value tv-browser-mono" : "tv-browser-state-value"}>{value}</span>
		</div>
	);
}

function RawData({ value }: { value?: string }): ReactNode {
	if (!value) return null;
	return (
		<details className="tv-browser-raw">
			<summary>{t("tools.rawData")}</summary>
			<pre>{value}</pre>
		</details>
	);
}

function WaitCard({ result, raw }: { result: Record<string, unknown>; raw?: string }): ReactNode {
	const timeout = result.outcome === "timeout";
	const condition = isRecord(result.condition) ? result.condition : {};
	return (
		<section className="tv-browser-structured" aria-label={t("tools.browserWaitResult")}>
			<div className="tv-browser-structured-head">
				<Globe size={13} aria-hidden="true" />
				<span>{t("tools.browserWaitResult")}</span>
			</div>
			<div className="tv-browser-state-grid">
				<Row
					label={t("tools.browserStatus")}
					value={t(timeout ? "tools.browserWaitTimeout" : "tools.browserWaitMatched")}
				/>
				{str(condition.kind) && <Row label={t("tools.browserCondition")} value={str(condition.kind)!} mono />}
				{typeof result.timeoutMs === "number" && (
					<Row label={t("tools.timeout")} value={`${result.timeoutMs}ms`} mono />
				)}
			</div>
			<div className="tv-browser-structured-head">
				<span>{t("tools.browserLastObserved")}</span>
			</div>
			<pre className="tv-browser-text-content">{JSON.stringify(result.lastObserved, null, 2)}</pre>
			<RawData value={raw} />
		</section>
	);
}

function NavigationCard({ navigation, raw }: { navigation: Record<string, unknown>; raw?: string }): ReactNode {
	return (
		<section className="tv-browser-structured" aria-label={t("tools.browserNavigation")}>
			<div className="tv-browser-structured-head">
				<Globe size={13} aria-hidden="true" />
				<span>{t("tools.browserNavigation")}</span>
			</div>
			<div className="tv-browser-state-grid">
				<Row label={t("tools.browserAction")} value={str(navigation.action) ?? "—"} />
				{str(navigation.title) && <Row label={t("tools.browserPage")} value={str(navigation.title)!} />}
				{str(navigation.url) && (
					<Row label={t("tools.browserCurrentUrl")} value={homePath(str(navigation.url)!)} mono />
				)}
			</div>
			<RawData value={raw} />
		</section>
	);
}

function HistoryCard({ records, raw }: { records: Record<string, unknown>[]; raw?: string }): ReactNode {
	return (
		<section className="tv-browser-structured" aria-label={t("tools.browserHistoryRecords")}>
			<div className="tv-browser-structured-head">
				<Globe size={13} aria-hidden="true" />
				<span>{t("tools.browserHistoryRecords")}</span>
			</div>
			<table className="tv-browser-state-table">
				<thead>
					<tr>
						<th>{t("tools.browserTabTitle")}</th>
						<th>{t("tools.url")}</th>
						<th>{t("tools.browserVisitedAt")}</th>
					</tr>
				</thead>
				<tbody>
					{records.map((record, index) => (
						<tr key={str(record.id) ?? index}>
							<td>{str(record.title) ?? str(record.url) ?? "—"}</td>
							<td className="tv-browser-mono">{str(record.url) ?? "—"}</td>
							<td className="tv-browser-mono">
								{typeof record.visitedAt === "number" ? record.visitedAt : "—"}
							</td>
						</tr>
					))}
				</tbody>
			</table>
			<RawData value={raw} />
		</section>
	);
}

function DownloadsCard({ records, raw }: { records: Record<string, unknown>[]; raw?: string }): ReactNode {
	return (
		<section className="tv-browser-structured" aria-label={t("tools.browserDownloadRecords")}>
			<div className="tv-browser-structured-head">
				<Globe size={13} aria-hidden="true" />
				<span>{t("tools.browserDownloadRecords")}</span>
			</div>
			<table className="tv-browser-state-table">
				<thead>
					<tr>
						<th>{t("tools.browserFileName")}</th>
						<th>{t("tools.browserStatus")}</th>
						<th>{t("tools.browserReceivedBytes")}</th>
						<th>{t("tools.browserSavePath")}</th>
					</tr>
				</thead>
				<tbody>
					{records.map((record, index) => (
						<tr key={str(record.id) ?? index}>
							<td>{str(record.fileName) ?? "—"}</td>
							<td>{str(record.status) ?? "—"}</td>
							<td className="tv-browser-mono">{`${String(record.receivedBytes ?? 0)} / ${String(record.totalBytes ?? 0)}`}</td>
							<td className="tv-browser-mono">{str(record.savePath) ? homePath(str(record.savePath)!) : "—"}</td>
						</tr>
					))}
				</tbody>
			</table>
			<RawData value={raw} />
		</section>
	);
}

function StatusCard({ status, raw }: { status: Record<string, unknown>; raw?: string }): ReactNode {
	const tabs = Array.isArray(status.tabs) ? status.tabs.filter(isRecord) : [];
	return (
		<section className="tv-browser-structured" aria-label={t("tools.browserState")}>
			<div className="tv-browser-structured-head">
				<Globe size={13} aria-hidden="true" />
				<span>{t("tools.browserState")}</span>
			</div>
			<div className="tv-browser-state-grid">
				<Row label={t("tools.browserAvailable")} value={bool(status.available)} />
				{typeof status.panelVisible === "boolean" && (
					<Row label={t("tools.browserPanelVisible")} value={bool(status.panelVisible)} />
				)}
				{str(status.activeTabId) && (
					<Row label={t("tools.browserControlledTab")} value={str(status.activeTabId)!} mono />
				)}
				{str(status.visibleTabId) && (
					<Row label={t("tools.browserVisibleTab")} value={str(status.visibleTabId)!} mono />
				)}
				{str(status.title) && <Row label={t("tools.browserPage")} value={str(status.title)!} />}
				{str(status.url) && <Row label={t("tools.browserCurrentUrl")} value={homePath(str(status.url)!)} mono />}
			</div>
			{tabs.length > 0 && (
				<div className="tv-browser-state-tabs">
					<div className="tv-browser-state-tabs-title">
						{t("tools.browserTabsWithCount", { count: String(tabs.length) })}
					</div>
					<table className="tv-browser-state-table">
						<thead>
							<tr>
								<th>{t("tools.browserTabId")}</th>
								<th>{t("tools.browserTabTitle")}</th>
								<th>{t("tools.browserControlled")}</th>
								<th>{t("tools.browserVisible")}</th>
								<th>{t("tools.browserLoading")}</th>
								<th>{t("tools.browserBack")}</th>
								<th>{t("tools.browserForward")}</th>
							</tr>
						</thead>
						<tbody>
							{tabs.map((tab, index) => (
								<tr key={str(tab.id) ?? index}>
									<td className="tv-browser-mono">{str(tab.id) ?? "—"}</td>
									<td title={str(tab.url) ?? undefined}>{str(tab.title) ?? str(tab.url) ?? "—"}</td>
									<td>{bool(tab.controlled)}</td>
									<td>{bool(tab.visible)}</td>
									<td>{bool(tab.loading)}</td>
									<td>{bool(tab.canGoBack)}</td>
									<td>{bool(tab.canGoForward)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
			<RawData value={raw} />
		</section>
	);
}

function TextCard({ page, raw }: { page: Record<string, unknown>; raw?: string }): ReactNode {
	return (
		<section className="tv-browser-structured" aria-label={t("tools.browserPageText")}>
			<div className="tv-browser-structured-head">
				<FileText size={13} aria-hidden="true" />
				<span>{t("tools.browserPageText")}</span>
				{str(page.title) && <span className="tv-browser-structured-title">{str(page.title)}</span>}
			</div>
			<div className="tv-browser-state-grid">
				<Row label={t("tools.browserScope")} value={str(page.scope) ?? "viewport"} mono />
				<Row
					label={t("tools.browserPageText")}
					value={t("tools.browserBlocksWithCount", { count: String(page.blockCount ?? 0) })}
				/>
				<Row label={t("tools.browserTruncated")} value={bool(page.truncated)} />
				<Row label={t("tools.browserScanTruncated")} value={bool(page.scanTruncated)} />
				{str(page.capturedAt) && <Row label={t("tools.browserCapturedAt")} value={str(page.capturedAt)!} mono />}
				{str(page.nextCursor) && <Row label={t("tools.browserNextCursor")} value={str(page.nextCursor)!} mono />}
			</div>
			<pre className="tv-browser-text-content">{str(page.text) ?? ""}</pre>
			<RawData value={raw} />
		</section>
	);
}

function ScreenshotCard({ shot, raw }: { shot: Record<string, unknown>; raw?: string }): ReactNode {
	const width = typeof shot.width === "number" ? shot.width : null;
	const height = typeof shot.height === "number" ? shot.height : null;
	return (
		<section className="tv-browser-structured" aria-label={t("tools.browserScreenshot")}>
			<div className="tv-browser-structured-head">
				<Camera size={13} aria-hidden="true" />
				<span>{t("tools.browserScreenshot")}</span>
			</div>
			<div className="tv-browser-state-grid">
				{width !== null && height !== null && (
					<Row label={t("tools.browserDimensions")} value={`${width}×${height}`} mono />
				)}
				{typeof shot.bytes === "number" && (
					<Row
						label={t("tools.browserSize")}
						value={t("tools.browserBytesWithCount", { count: String(shot.bytes) })}
					/>
				)}
				{str(shot.capturedAt) && <Row label={t("tools.browserCapturedAt")} value={str(shot.capturedAt)!} mono />}
				{str(shot.dest) && <Row label={t("tools.browserPath")} value={homePath(str(shot.dest)!)} mono />}
			</div>
			<RawData value={raw} />
		</section>
	);
}

function ElementsCard({ snapshot, raw }: { snapshot: Record<string, unknown>; raw?: string }): ReactNode {
	const elements = Array.isArray(snapshot.elements) ? snapshot.elements.filter(isRecord) : [];
	return (
		<section className="tv-browser-structured" aria-label={t("tools.browserElementSnapshot")}>
			<div className="tv-browser-structured-head">
				<ListChecks size={13} aria-hidden="true" />
				<span>{t("tools.browserElementSnapshot")}</span>
				{str(snapshot.title) && <span className="tv-browser-structured-title">{str(snapshot.title)}</span>}
			</div>
			<div className="tv-browser-state-grid">
				<Row label={t("tools.browserSnapshotId")} value={str(snapshot.snapshotId) ?? "—"} mono />
				<Row label={t("tools.browserScope")} value={str(snapshot.scope) ?? "viewport"} mono />
				<Row
					label={t("tools.browserElements")}
					value={`${String(snapshot.returned ?? elements.length)} / ${String(snapshot.total ?? elements.length)}`}
				/>
				<Row label={t("tools.browserTruncated")} value={bool(snapshot.truncated)} />
				{str(snapshot.nextCursor) && (
					<Row label={t("tools.browserNextCursor")} value={str(snapshot.nextCursor)!} mono />
				)}
				{str(snapshot.capturedAt) && (
					<Row label={t("tools.browserCapturedAt")} value={str(snapshot.capturedAt)!} mono />
				)}
			</div>
			{elements.length > 0 && (
				<table className="tv-browser-state-table tv-browser-elements-table">
					<thead>
						<tr>
							<th>{t("tools.browserRef")}</th>
							<th>{t("tools.browserRole")}</th>
							<th>{t("tools.browserName")}</th>
							<th>{t("tools.browserState")}</th>
						</tr>
					</thead>
					<tbody>
						{elements.map((element, index) => (
							<tr key={str(element.ref) ?? index}>
								<td className="tv-browser-mono">{str(element.ref) ?? "—"}</td>
								<td>{str(element.role) ?? "—"}</td>
								<td>{str(element.name) ?? "—"}</td>
								<td>{Array.isArray(element.states) ? element.states.join(", ") : "—"}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			<RawData value={raw} />
		</section>
	);
}

function VisualCard({ snapshot, raw }: { snapshot: Record<string, unknown>; raw?: string }): ReactNode {
	const image = isRecord(snapshot.image) ? snapshot.image : {};
	const viewport = isRecord(snapshot.viewport) ? snapshot.viewport : {};
	return (
		<section className="tv-browser-structured" aria-label={t("tools.browserVisualSnapshot")}>
			<div className="tv-browser-structured-head">
				<Camera size={13} aria-hidden="true" />
				<span>{t("tools.browserVisualSnapshot")}</span>
				{str(snapshot.title) && <span className="tv-browser-structured-title">{str(snapshot.title)}</span>}
			</div>
			<div className="tv-browser-state-grid">
				<Row label={t("tools.browserSnapshotId")} value={str(snapshot.snapshotId) ?? "—"} mono />
				{typeof image.width === "number" && typeof image.height === "number" && (
					<Row label={t("tools.browserDimensions")} value={`${image.width}×${image.height}`} mono />
				)}
				{typeof viewport.width === "number" && typeof viewport.height === "number" && (
					<Row label={t("tools.browserViewport")} value={`${viewport.width}×${viewport.height}`} mono />
				)}
				<Row label={t("tools.browserCoordinateSpace")} value={t("tools.browserScreenshotPixels")} />
				{str(snapshot.capturedAt) && (
					<Row label={t("tools.browserCapturedAt")} value={str(snapshot.capturedAt)!} mono />
				)}
			</div>
			<RawData value={raw} />
		</section>
	);
}

function VisualCropCard({ crop, raw }: { crop: Record<string, unknown>; raw?: string }): ReactNode {
	const image = isRecord(crop.image) ? crop.image : {};
	const region = isRecord(crop.region) ? crop.region : {};
	return (
		<section className="tv-browser-structured" aria-label={t("tools.browserVisualCrop")}>
			<div className="tv-browser-structured-head">
				<Camera size={13} aria-hidden="true" />
				<span>{t("tools.browserVisualCrop")}</span>
			</div>
			<div className="tv-browser-state-grid">
				<Row label={t("tools.browserSourceSnapshot")} value={str(crop.sourceSnapshotId) ?? "—"} mono />
				{typeof region.width === "number" && typeof region.height === "number" && (
					<Row label={t("tools.browserDimensions")} value={`${region.width}×${region.height}`} mono />
				)}
				{typeof region.x === "number" && typeof region.y === "number" && (
					<Row label={t("tools.browserCropRegion")} value={`${region.x}, ${region.y}`} mono />
				)}
				{str(crop.capturedAt) && <Row label={t("tools.browserCapturedAt")} value={str(crop.capturedAt)!} mono />}
				{str(image.dest) && <Row label={t("tools.browserPath")} value={homePath(str(image.dest)!)} mono />}
			</div>
			<RawData value={raw} />
		</section>
	);
}

function DeviceProfilesCard({ profiles, raw }: { profiles: Record<string, unknown>[]; raw?: string }): ReactNode {
	return (
		<section className="tv-browser-structured" aria-label={t("tools.browserDeviceProfiles")}>
			<div className="tv-browser-structured-head">
				<Globe size={13} aria-hidden="true" />
				<span>{t("tools.browserDeviceProfiles")}</span>
			</div>
			<div className="tv-browser-state-grid">
				{profiles.map((profile, index) => (
					<Row
						key={str(profile.id) ?? index}
						label={str(profile.id) ?? "—"}
						value={
							typeof profile.width === "number" && typeof profile.height === "number"
								? `${profile.width}×${profile.height}`
								: (str(profile.id) ?? "—")
						}
						mono
					/>
				))}
			</div>
			<RawData value={raw} />
		</section>
	);
}

function DeviceCard({ configuration, raw }: { configuration: Record<string, unknown>; raw?: string }): ReactNode {
	const viewport = isRecord(configuration.viewport) ? configuration.viewport : {};
	return (
		<section className="tv-browser-structured" aria-label={t("tools.browserDeviceConfiguration")}>
			<div className="tv-browser-structured-head">
				<Globe size={13} aria-hidden="true" />
				<span>{t("tools.browserDeviceConfiguration")}</span>
			</div>
			<div className="tv-browser-state-grid">
				<Row label={t("tools.browserDeviceEnabled")} value={bool(configuration.enabled)} />
				{str(configuration.profileId) && (
					<Row label={t("tools.browserDeviceProfile")} value={str(configuration.profileId)!} mono />
				)}
				{typeof viewport.width === "number" && typeof viewport.height === "number" && (
					<Row label={t("tools.browserViewport")} value={`${viewport.width}×${viewport.height}`} mono />
				)}
				{str(configuration.orientation) && (
					<Row
						label={t("tools.browserDeviceOrientation")}
						value={t(
							configuration.orientation === "landscape" ? "tools.browserLandscape" : "tools.browserPortrait",
						)}
					/>
				)}
				{str(configuration.scaleMode) && (
					<Row
						label={t("tools.browserDeviceScaleMode")}
						value={t(configuration.scaleMode === "fixed" ? "tools.browserScaleFixed" : "tools.browserScaleFit")}
					/>
				)}
				{typeof configuration.scale === "number" && (
					<Row label={t("tools.browserDeviceScale")} value={`${configuration.scale * 100}%`} mono />
				)}
				{typeof viewport.isMobile === "boolean" && (
					<Row label={t("tools.browserDeviceMobile")} value={bool(viewport.isMobile)} />
				)}
				{typeof viewport.hasTouch === "boolean" && (
					<Row label={t("tools.browserDeviceTouch")} value={bool(viewport.hasTouch)} />
				)}
			</div>
			<RawData value={raw} />
		</section>
	);
}

function VisualInteractionCard({
	interaction,
	raw,
}: {
	interaction: Record<string, unknown>;
	raw?: string;
}): ReactNode {
	const candidates = Array.isArray(interaction.candidates) ? interaction.candidates.filter(isRecord) : [];
	const clicked = interaction.outcome === "clicked";
	const target = isRecord(interaction.target) ? interaction.target : null;
	const label = t(clicked ? "tools.browserActionReceipt" : "tools.browserCandidates");
	return (
		<section className="tv-browser-structured" aria-label={label}>
			<div className="tv-browser-structured-head">
				<MousePointerClick size={13} aria-hidden="true" />
				<span>{label}</span>
				{interaction.outcome === "candidates" && <span>{t("tools.browserNoClickPerformed")}</span>}
			</div>
			{clicked && (
				<div className="tv-browser-state-grid">
					<Row label={t("tools.browserStatus")} value={t("tools.completed")} />
					{str(target?.role) && <Row label={t("tools.browserRole")} value={str(target?.role)!} />}
					{str(target?.name) && <Row label={t("tools.browserName")} value={str(target?.name)!} />}
				</div>
			)}
			{candidates.length > 0 && (
				<table className="tv-browser-state-table">
					<thead>
						<tr>
							<th>{t("tools.browserRole")}</th>
							<th>{t("tools.browserName")}</th>
							<th>{t("tools.browserTarget")}</th>
						</tr>
					</thead>
					<tbody>
						{candidates.map((candidate, index) => (
							<tr key={index}>
								<td>{str(candidate.role) ?? "—"}</td>
								<td>{str(candidate.name) ?? "—"}</td>
								<td className="tv-browser-mono">{`${str(candidate.x) ?? "—"}, ${str(candidate.y) ?? "—"}`}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			<RawData value={raw} />
		</section>
	);
}

function ReceiptCard({ receipt, raw }: { receipt: Record<string, unknown>; raw?: string }): ReactNode {
	const failed = receipt.status === "failed";
	return (
		<section
			className={`tv-browser-structured tv-browser-receipt${failed ? " tv-browser-receipt--failed" : ""}`}
			aria-label={t("tools.browserActionReceipt")}
		>
			<div className="tv-browser-structured-head">
				<MousePointerClick size={13} aria-hidden="true" />
				<span>{t("tools.browserActionReceipt")}</span>
			</div>
			<div className="tv-browser-state-grid">
				<Row label={t("tools.browserAction")} value={str(receipt.action) ?? "—"} />
				<Row label={t("tools.browserStatus")} value={failed ? t("tools.failed") : t("tools.completed")} />
				{str(receipt.target) && <Row label={t("tools.browserTarget")} value={str(receipt.target)!} mono />}
				{str(receipt.url) && <Row label={t("tools.browserCurrentUrl")} value={str(receipt.url)!} mono />}
				{str(receipt.error) && <Row label={t("tools.browserError")} value={str(receipt.error)!} />}
			</div>
			<RawData value={raw} />
		</section>
	);
}

function DialogCard({
	dialog,
	pending,
	raw,
}: {
	dialog: Record<string, unknown>;
	pending: boolean;
	raw?: string;
}): ReactNode {
	const outcome = str(dialog.outcome);
	const answerer = str(dialog.answerer);
	return (
		<article
			className="tv-browser-structured"
			aria-label={t(pending ? "tools.browserPendingDialog" : "tools.browserHandledDialog")}
		>
			<div className="tv-browser-structured-head">
				<MessageSquareWarning size={13} aria-hidden="true" />
				<span>{t(pending ? "tools.browserPendingDialog" : "tools.browserHandledDialog")}</span>
			</div>
			<div className="tv-browser-state-grid">
				<Row label={t("tools.browserDialogType")} value={str(dialog.kind) ?? "—"} mono />
				<Row label={t("tools.browserDialogMessage")} value={str(dialog.message) ?? ""} />
				{str(dialog.defaultValue) !== null && (
					<Row label={t("tools.browserDialogDefaultValue")} value={str(dialog.defaultValue)!} />
				)}
				{str(dialog.text) !== null && <Row label={t("tools.browserDialogAnswer")} value={str(dialog.text)!} />}
				{answerer && (
					<Row
						label={t("tools.browserDialogAnswerer")}
						value={
							answerer === "agent"
								? t("tools.browserDialogAgent")
								: answerer === "user"
									? t("tools.browserDialogUser")
									: t("tools.browserDialogAuto")
						}
					/>
				)}
				{outcome && (
					<Row
						label={t("tools.browserStatus")}
						value={
							outcome === "accepted"
								? t("tools.browserDialogAccepted")
								: outcome === "dismissed"
									? t("tools.browserDialogDismissed")
									: t("tools.browserDialogCancelled")
						}
					/>
				)}
			</div>
			<RawData value={raw} />
		</article>
	);
}

function ControlCard({ control, raw }: { control: Record<string, unknown>; raw?: string }): ReactNode {
	return (
		<section className="tv-browser-structured" aria-label={t("tools.browserControl")}>
			<div className="tv-browser-structured-head">
				<Globe size={13} aria-hidden="true" />
				<span>{t("tools.browserControl")}</span>
			</div>
			<div className="tv-browser-state-grid">
				<Row label={t("tools.browserAction")} value={str(control.action) ?? "—"} />
				{str(control.activeTabId) && (
					<Row label={t("tools.browserControlledTab")} value={str(control.activeTabId)!} mono />
				)}
				{str(control.visibleTabId) && (
					<Row label={t("tools.browserVisibleTab")} value={str(control.visibleTabId)!} mono />
				)}
				{typeof control.panelVisible === "boolean" && (
					<Row label={t("tools.browserPanelVisible")} value={bool(control.panelVisible)} />
				)}
				{control.released === true && <Row label={t("tools.browserReleased")} value={t("tools.browserYes")} />}
				{control.released === true && (
					<Row label={t("tools.browserPageState")} value={t("tools.browserPageRemainsOpen")} />
				)}
			</div>
			<RawData value={raw} />
		</section>
	);
}

export function StructuredBrowserResult({
	action,
	result,
}: {
	action: string | null;
	result: ToolRenderProps["result"];
}): ReactNode {
	const details = browserStructuredOf(result);
	if (!details) return null;
	if (action === "status" && details.status) return <StatusCard status={details.status} raw={details.result} />;
	if (action === "read" && details.pageText) return <TextCard page={details.pageText} raw={details.result} />;
	if (action === "screenshot" && details.pageScreenshot) {
		return <ScreenshotCard shot={details.pageScreenshot} raw={details.result} />;
	}
	if (action === "elements" && details.elementsSnapshot) {
		return <ElementsCard snapshot={details.elementsSnapshot} raw={details.result} />;
	}
	if (action === "visual" && details.visualSnapshot) {
		return <VisualCard snapshot={details.visualSnapshot} raw={details.result} />;
	}
	if (action === "visual_crop" && details.visualCrop) {
		return <VisualCropCard crop={details.visualCrop} raw={details.result} />;
	}
	if (action === "device_profiles" && details.deviceProfiles) {
		return <DeviceProfilesCard profiles={details.deviceProfiles} raw={details.result} />;
	}
	if (action === "set_device" && details.deviceConfiguration) {
		return <DeviceCard configuration={details.deviceConfiguration} raw={details.result} />;
	}
	if (details.waitResult) return <WaitCard result={details.waitResult} raw={details.result} />;
	if (details.navigation) return <NavigationCard navigation={details.navigation} raw={details.result} />;
	if (action === "history" && details.history) return <HistoryCard records={details.history} raw={details.result} />;
	if (action === "downloads" && details.downloads) {
		return <DownloadsCard records={details.downloads} raw={details.result} />;
	}
	const pendingDialog = details.pendingDialogs?.[0];
	const handledDialog = details.handledDialogs?.at(-1);
	if (pendingDialog || ((action === "dialog" || action === "dialog_respond") && handledDialog)) {
		return (
			<DialogCard
				dialog={pendingDialog ?? handledDialog!}
				pending={pendingDialog !== undefined}
				raw={details.result}
			/>
		);
	}
	if (details.visualInteraction)
		return <VisualInteractionCard interaction={details.visualInteraction} raw={details.result} />;
	if (details.control) return <ControlCard control={details.control} raw={details.result} />;
	if (details.actionReceipt) return <ReceiptCard receipt={details.actionReceipt} raw={details.result} />;
	return null;
}

/** Detail keys the cards above already consume (or that would flood the fold
 *  with media/base64). Everything else is still shown, so a field added by a
 *  newer daemon never becomes invisible just because this file predates it. */
const CONSUMED_DETAIL_KEYS = new Set([
	"action",
	"name",
	"url",
	"browser",
	"viewport",
	"status",
	"pageText",
	"pageScreenshot",
	"elementsSnapshot",
	"visualSnapshot",
	"visualCrop",
	"deviceProfiles",
	"deviceConfiguration",
	"history",
	"downloads",
	"navigation",
	"waitResult",
	"visualInteraction",
	"actionReceipt",
	"pendingDialogs",
	"handledDialogs",
	"control",
	"screenshots",
	"operations",
	"observation",
	"meta",
	"code",
	"readOnly",
	"result",
]);

function restValue(value: unknown): string | null {
	if (value === null) return t("tools.browserUnknown");
	if (typeof value === "boolean") return value ? t("tools.browserYes") : t("tools.browserNo");
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
	if (typeof value === "string") return value.length > 120 ? `${value.slice(0, 117)}…` : value;
	if (Array.isArray(value) || typeof value === "object") {
		try {
			const text = JSON.stringify(value);
			return text.length <= 160 ? text : null;
		} catch {
			return null;
		}
	}
	return null;
}

/** Fields this card set did not render. Folded, and empty renders nothing. */
export function OtherBrowserFields({ result }: { result: ToolRenderProps["result"] }): ReactNode {
	const details = detailsRecord(result);
	if (!details) return null;
	const rows: Array<[string, string]> = [];
	for (const [key, value] of Object.entries(details)) {
		if (CONSUMED_DETAIL_KEYS.has(key)) continue;
		const text = restValue(value);
		if (text !== null && text.length > 0) rows.push([key, text]);
	}
	if (rows.length === 0) return null;
	return (
		<details className="tv-browser-rest">
			<summary>{t("tools.browserOtherFields")}</summary>
			<dl>
				{rows.map(([key, value]) => (
					<div key={key}>
						<dt>{key}</dt>
						<dd>{value}</dd>
					</div>
				))}
			</dl>
		</details>
	);
}
