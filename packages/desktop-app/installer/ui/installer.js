/**
 * MusePi installer UI controller.
 *
 * The native host owns validation and writes the wizard answers. After the
 * Install command succeeds, the host closes and NSIS shows the real extraction
 * progress and completion page. This controller never simulates file progress.
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
let installing = false;

function beginInstall() {
	if (installing) return;
	installing = true;
	showPage("progress");
	setProgress(0, locale.preparing);
	send("install", {
		path: pathInput.value,
		desktopShortcut: desktopCheckbox.checked,
		startMenu: startMenuCheckbox.checked,
		language: selectedLanguage,
	});
	if (!host) {
		// Explicit preview-only feedback. Production waits for the native host.
		installing = false;
		showPage("location");
	}
}

document.getElementById("btn-install").addEventListener("click", beginInstall);
document.getElementById("btn-retry").addEventListener("click", beginInstall);
document.getElementById("btn-browse").addEventListener("click", () => send("pick-directory"));

document.getElementById("btn-finish").addEventListener("click", () => {
	send(launchCheckbox.checked ? "launch" : "finish");
});

// ── Progress rendering ─────────────────────────────────────────────────
const bar = document.getElementById("bar");
const barFill = bar.querySelector(".fill");
const percentLabel = document.getElementById("progress-percent");
const stepLabel = document.getElementById("progress-label");
const headingStep = document.getElementById("progress-step");

function setProgress(percent, step) {
	const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
	barFill.style.width = `${clamped}%`;
	bar.setAttribute("aria-valuenow", String(Math.round(clamped)));
	percentLabel.textContent = `${Math.round(clamped)}%`;
	if (step) {
		stepLabel.textContent = step;
		headingStep.textContent = step;
	}
}

// ── Host bridge ────────────────────────────────────────────────────────
function onHostMessage(event) {
	let message = event.data;
	if (typeof message === "string") {
		try {
			message = JSON.parse(message);
		} catch {
			showError(String(event.data));
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
			setProgress(message.percent, message.step);
			break;
		case "handoff":
			setProgress(100, locale.handingOff);
			break;
		case "error":
			installing = false;
			showError(message.message || locale.unknownError);
			break;
		case "directory-picked":
			if (message.path) pathInput.value = message.path;
			break;
		default:
			console.info("[host]", message);
	}
}

function showError(text) {
	document.getElementById("error-message").textContent = text;
	showPage("error");
}

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
		send("close");
	}
});
