/**
 * MusePi installer UI controller.
 *
 * Runs inside WebView2 (hosted by InstallerHost.exe) but must also work when the
 * page is opened directly in a browser for design review — that dual mode is
 * what makes the UI iterable without rebuilding the host. When
 * `window.chrome.webview` is absent, messages are logged to the console and
 * installation steps are simulated, so every page can still be walked.
 *
 * The host is the single source of truth for install progress: the UI never
 * fakes it. `host:progress` drives the bar.
 */

const host = window.chrome?.webview ?? null;

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
	// A page swap resets scroll; the wizard is short enough that keeping the
	// previous scroll offset would show a half-scrolled next step.
	const content = document.getElementById("content");
	if (content) content.scrollTop = 0;
	for (const [key, node] of Object.entries(pages)) {
		node.classList.toggle("active", key === name);
	}
	document.body.dataset.page = name;
}

// ── Language radio group ───────────────────────────────────────────────
const langOptions = [...document.querySelectorAll('.langs [role="radio"]')];
let selectedLanguage = "zh-CN";

function selectLanguage(option) {
	selectedLanguage = option.dataset.lang;
	for (const item of langOptions) {
		item.setAttribute("aria-checked", String(item === option));
	}
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

// Frameless drag: hand off to the host, which runs the native caption drag.
// Doing it here (rather than CSS -webkit-app-region) keeps the same code path
// in the WebView2 host and in browser preview.
const titlebar = document.querySelector(".titlebar");
titlebar.addEventListener("mousedown", event => {
	if (event.button === 0 && !event.target.closest(".wincontrols")) send("drag");
});

// ── Install ────────────────────────────────────────────────────────────
const pathInput = document.getElementById("path");
const desktopCheckbox = document.getElementById("chk-desktop");
const startMenuCheckbox = document.getElementById("chk-startmenu");
const launchCheckbox = document.getElementById("chk-launch");

function beginInstall() {
	showPage("progress");
	send("install", {
		path: pathInput.value,
		desktopShortcut: desktopCheckbox.checked,
		startMenu: startMenuCheckbox.checked,
		language: selectedLanguage,
	});
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
			// Some hosts post bare commands; treat them as errors with the text.
			showError(String(event.data));
			return;
		}
	}
	handleHostMessage(message);
}

function handleHostMessage(message) {
	if (!message || typeof message !== "object") return;

	switch (message.type) {
		case "ready":
			if (message.appVersion) {
				document.getElementById("app-version").textContent = `版本 ${message.appVersion}`;
			}
			if (message.defaultPath) pathInput.value = message.defaultPath;
			break;
		case "progress":
			showPage("progress");
			setProgress(message.percent, message.step);
			break;
		case "installed":
			setProgress(100, "安装完成");
			showPage("done");
			break;
		case "error":
			showError(message.message || "未知错误");
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
	// Tell the host the UI is live so it can push version/path defaults.
	send("ui-ready");
} else {
	// Browser preview: populate placeholder metadata so the design can be
	// reviewed without the native host.
	handleHostMessage({ type: "ready", appVersion: "0.5.6", defaultPath: "%LOCALAPPDATA%\\Programs\\MusePi" });
	pathInput.value = "%LOCALAPPDATA%\\Programs\\MusePi";
	console.info("[preview] no chrome.webview — pages are walkable, install is simulated");
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
