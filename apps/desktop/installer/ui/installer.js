/**
 * MusePi installer UI controller.
 *
 * The host owns validation, the answers file and the install itself: it starts
 * the installer, polls the phase it publishes (install-status.ini) and the bytes
 * that actually exist under the target. This controller renders exactly those
 * facts — there is no percentage, because a silent NSIS file section has none.
 * Browser preview mode only demonstrates navigation.
 */

const host = window.chrome?.webview ?? null;
const i18n = window.MusePiInstallerI18n;

/** Post a command to the native host. No-op (logged) in browser preview. */
function send(command, payload) {
	const message = payload === undefined ? command : `${command}:${JSON.stringify(payload)}`;
	if (host) host.postMessage(message);
	else console.info("[preview] ->", message);
}

// ── Page routing ───────────────────────────────────────────────────────
const pages = {
	language: document.getElementById("page-language"),
	location: document.getElementById("page-location"),
	progress: document.getElementById("page-progress"),
	done: document.getElementById("page-done"),
	error: document.getElementById("page-error"),
};

function showPage(name) {
	const content = document.getElementById("content");
	if (content) content.scrollTop = 0;
	for (const [key, node] of Object.entries(pages)) {
		node.classList.toggle("active", key === name);
	}
	document.body.dataset.page = name;
}

// ── Language radio group ───────────────────────────────────────────────
const langOptions = [...document.querySelectorAll('.langs [role="radio"]')];
let selectedLanguage = "en-US";
let locale = i18n.apply(selectedLanguage, document);

function selectLanguage(option, notifyHost = true) {
	selectedLanguage = i18n.normalise(option.dataset.lang);
	locale = i18n.apply(selectedLanguage, document);
	for (const item of langOptions) {
		item.setAttribute("aria-checked", String(item === option));
	}
	if (notifyHost) send(`language:${selectedLanguage}`);
}

for (const option of langOptions) {
	option.addEventListener("click", () => selectLanguage(option));
	option.addEventListener("keydown", event => {
		if (event.key === " " || event.key === "Enter") {
			event.preventDefault();
			selectLanguage(option);
			return;
		}
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		event.preventDefault();
		const index = langOptions.indexOf(option);
		const delta = event.key === "ArrowDown" ? 1 : -1;
		const next = langOptions[(index + delta + langOptions.length) % langOptions.length];
		selectLanguage(next);
		next.focus();
	});
}

// ── Navigation ─────────────────────────────────────────────────────────
for (const button of document.querySelectorAll("[data-next]")) {
	button.addEventListener("click", () => showPage(button.dataset.next));
}
for (const button of document.querySelectorAll("[data-back]")) {
	button.addEventListener("click", () => showPage(button.dataset.back));
}

// ── Window chrome ──────────────────────────────────────────────────────
document.getElementById("btn-min").addEventListener("click", () => send("minimize"));
document.getElementById("btn-close").addEventListener("click", () => send("close"));

const titlebar = document.querySelector(".titlebar");
titlebar.addEventListener("mousedown", event => {
	if (event.button === 0 && !event.target.closest(".wincontrols")) send("drag");
});

// ── Install ────────────────────────────────────────────────────────────
const pathInput = document.getElementById("path");
const desktopCheckbox = document.getElementById("chk-desktop");
const startMenuCheckbox = document.getElementById("chk-startmenu");
const launchCheckbox = document.getElementById("chk-launch");
const cancelButton = document.getElementById("btn-cancel");
const cancelConfirm = document.getElementById("cancel-confirm");
const cancelConfirmButton = document.getElementById("btn-cancel-confirm");
const cancelKeepButton = document.getElementById("btn-cancel-keep");
let installing = false;

function beginInstall() {
	if (installing) return;
	installing = true;
	resetProgress();
	showPage("progress");
	send("install", {
		path: pathInput.value,
		desktopShortcut: desktopCheckbox.checked,
		startMenu: startMenuCheckbox.checked,
		language: selectedLanguage,
	});
	if (!host) {
		// Preview-only demo of the two states; no installation is performed.
		setTimeout(() => {
			setPhase(locale.writingFiles);
			setBytes(18 * 1024 * 1024);
		}, 500);
		setTimeout(() => showPage("done"), 1400);
	}
}

document.getElementById("btn-install").addEventListener("click", beginInstall);
document.getElementById("btn-retry").addEventListener("click", beginInstall);
document.getElementById("btn-browse").addEventListener("click", () => send("pick-directory"));

document.getElementById("btn-finish").addEventListener("click", () => {
	send(launchCheckbox.checked ? "launch" : "finish");
});

// ── Cancel ─────────────────────────────────────────────────────────────
function openCancelConfirm() {
	if (!installing) return;
	cancelConfirm.hidden = false;
	cancelConfirmButton.focus();
}

function closeCancelConfirm() {
	cancelConfirm.hidden = true;
	cancelButton.focus();
}

cancelButton.addEventListener("click", openCancelConfirm);
cancelKeepButton.addEventListener("click", closeCancelConfirm);
cancelConfirmButton.addEventListener("click", () => {
	cancelConfirm.hidden = true;
	cancelButton.disabled = true;
	setPhase(locale.cancelling);
	send("cancel");
});

// ── Progress rendering ─────────────────────────────────────────────────
const bar = document.getElementById("bar");
const bytesLabel = document.getElementById("progress-bytes");
const headingStep = document.getElementById("progress-step");

/**
 * The installer cannot say how far its file copy has got. `phase` is the stage
 * the installer published, and the bar stays indeterminate on purpose.
 */
function setPhase(text) {
	headingStep.textContent = text;
}

function setBytes(bytes) {
	const value = Number(bytes);
	if (!value || value <= 0) {
		bytesLabel.textContent = "";
		return;
	}
	if (value < 1024 * 1024) {
		const kilobytes = Math.max(1, Math.round(value / 1024));
		bytesLabel.textContent = locale.bytesWrittenKb.replace("{size}", String(kilobytes));
		return;
	}
	const megabytes = (value / (1024 * 1024)).toFixed(1);
	bytesLabel.textContent = locale.bytesWritten.replace("{size}", megabytes);
}

function resetProgress() {
	cancelButton.disabled = false;
	cancelConfirm.hidden = true;
	bar.setAttribute("aria-busy", "true");
	setBytes(0);
	setPhase(locale.preparing);
}

// ── Host bridge ────────────────────────────────────────────────────────
function onHostMessage(event) {
	let message = event.data;
	if (typeof message === "string") {
		try {
			message = JSON.parse(message);
		} catch {
			showRetryable(String(event.data));
			return;
		}
	}
	handleHostMessage(message);
}

function handleHostMessage(message) {
	if (!message || typeof message !== "object") return;

	switch (message.type) {
		case "ready": {
			const language = i18n.normalise(message.language || selectedLanguage);
			const option = langOptions.find(item => item.dataset.lang === language) || langOptions[0];
			selectLanguage(option, false);
			if (message.appVersion) {
				document.getElementById("app-version").textContent = locale.version.replace("{version}", message.appVersion);
			}
			if (message.defaultPath) pathInput.value = message.defaultPath;
			break;
		}
		case "progress":
			if (message.phase === "preparing") setPhase(locale.preparing);
			else if (message.phase === "awaiting") setPhase(locale.awaitingInstaller);
			else if (message.phase === "installing") setPhase(locale.writingFiles);
			else if (message.phase === "cancelling") setPhase(locale.cancelling);
			if (typeof message.bytes === "number") setBytes(message.bytes);
			break;
		case "installed":
			installing = false;
			bar.setAttribute("aria-busy", "false");
			showPage("done");
			break;
		case "cancelled":
			installing = false;
			showFinished(locale.cancelledTitle, message.upgrade ? locale.cancelledUpgrade : locale.cancelledFresh);
			break;
		case "failed":
			installing = false;
			showFinished(locale.failedTitle,
				message.reason === "installerExited"
					? (message.upgrade ? locale.failedUpgrade : locale.failedFresh)
					: locale.failedSilent);
			break;
		case "error":
			installing = false;
			showRetryable(message.reason === "clientRunning"
				? locale.clientRunning
				: message.message || locale.unknownError);
			break;
		case "directory-picked":
			if (message.path) pathInput.value = message.path;
			break;
		default:
			console.info("[host]", message);
	}
}

/** Pre-install refusal: the user can fix the cause and retry here. */
function showRetryable(text) {
	document.getElementById("h-error").textContent = locale.errorTitle;
	document.getElementById("error-message").textContent = text;
	document.getElementById("error-back").hidden = false;
	document.getElementById("error-close").hidden = true;
	document.getElementById("btn-retry").hidden = false;
	showPage("error");
}

/**
 * The install this run started is over and the installer is gone: retrying here
 * would start nothing, so the only action is to close and run setup again.
 */
function showFinished(title, text) {
	document.getElementById("h-error").textContent = title;
	document.getElementById("error-message").textContent = text;
	document.getElementById("error-back").hidden = true;
	document.getElementById("error-close").hidden = false;
	document.getElementById("btn-retry").hidden = true;
	showPage("error");
}

document.getElementById("error-close").addEventListener("click", () => send("close"));

if (host) {
	host.addEventListener("message", onHostMessage);
	send("ui-ready");
} else {
	handleHostMessage({ type: "ready", language: "zh-CN", appVersion: "0.7.0", defaultPath: "%LOCALAPPDATA%\\Programs\\MusePi" });
	console.info("[preview] no chrome.webview — navigation only; no installation is performed");
}

// Keyboard: Enter advances on non-progress pages, Escape closes.
document.addEventListener("keydown", event => {
	const page = document.body.dataset.page;
	if (event.key === "Enter" && page === "language") {
		event.preventDefault();
		showPage("location");
		return;
	}
	if (event.key === "Enter" && page === "done") {
		event.preventDefault();
		document.getElementById("btn-finish").click();
		return;
	}
	if (event.key === "Escape") {
		event.preventDefault();
		if (!cancelConfirm.hidden) {
			closeCancelConfirm();
			return;
		}
		send("close");
	}
});