/* MusePi installer locale catalog. Kept dependency-free for WebView2 and VM tests. */
(function initialiseInstallerI18n(root) {
	const selectors = {
		windowTitle: ".brandline .name",
		languageTitle: "#h-language",
		languageLede: "#page-language .lede",
		perUser: "#page-language .hint",
		continue: '[data-next="location"]',
		locationTitle: "#h-location",
		locationLede: "#page-location .lede",
		targetFolder: 'label[for="path"]',
		browse: "#btn-browse",
		desktopShortcut: "#chk-desktop",
		startMenu: "#chk-startmenu",
		back: '[data-back="language"]',
		install: "#btn-install",
		progressTitle: "#h-progress",
		preparing: "#progress-step",
		cancel: "#btn-cancel",
		cancelHint: "#cancel-hint",
		cancelKeep: "#btn-cancel-keep",
		cancelConfirmLabel: "#btn-cancel-confirm",
		doneTitle: "#h-done",
		doneLede: "#page-done .lede",
		launchNow: "#chk-launch",
		dataLocal: "#page-done .hint",
		finish: "#btn-finish",
		errorTitle: "#h-error",
		unknownError: "#error-message",
		errorBack: "#error-back",
		retry: "#btn-retry",
		close: "#error-close",
	};

	const attributeSelectors = {
		minimize: ["#btn-min", "aria-label"],
		closeButton: ["#btn-close", "aria-label"],
	};

	const locales = {
		"en-US": {
			installerTitle: "MusePi Setup",
			windowTitle: "MusePi Setup",
			minimize: "Minimize",
			closeButton: "Close",
			version: "Version {version}",
			languageTitle: "Choose a language",
			languageLede: "Used during setup and when MusePi first starts. You can change it later in Settings.",
			perUser: "Per-user installation · No administrator rights required",
			continue: "Continue",
			locationTitle: "Choose an install location",
			locationLede: "Install MusePi on this computer and launch it from a desktop shortcut. Settings and sessions are stored separately and kept when you uninstall.",
			targetFolder: "Destination folder",
			browse: "Browse…",
			desktopShortcut: "Create a desktop shortcut",
			startMenu: "Add to Start menu",
			back: "Back",
			install: "Install",
			progressTitle: "Installing",
			preparing: "Checking the installation environment…",
			awaitingInstaller: "Starting the installation…",
			writingFiles: "Writing application files…",
			cancelling: "Cancelling setup…",
			bytesWrittenKb: "Written {size} KB",
			bytesWritten: "Written {size} MB",
			cancel: "Cancel setup",
			cancelHint: "Cancelling stops setup and removes the files this run has written.",
			cancelKeep: "Keep installing",
			cancelConfirmLabel: "Cancel setup",
			doneTitle: "MusePi is ready",
			doneLede: "Installation is complete. The first launch helps you choose a language and configure a model provider.",
			launchNow: "Launch MusePi now",
			dataLocal: "Settings and sessions stay on this computer",
			finish: "Finish",
			errorTitle: "Installation failed",
			cancelledTitle: "Setup cancelled",
			cancelledFresh: "The files written by this run were removed.",
			cancelledUpgrade: "The upgrade did not finish. Some files may already be replaced; run setup again to repair the installation.",
			failedTitle: "Installation failed",
			failedFresh: "Setup exited before it finished. The files written by this run were removed.",
			failedUpgrade: "Setup exited before it finished. Some files from the previous version may already be replaced; run setup again to repair the installation.",
			failedSilent: "Setup never started writing files. Run setup again.",
			clientRunning: "MusePi is running. Close all MusePi windows, then retry. Setup will not force your application to close.",
			unknownError: "Unknown error",
			errorBack: "Back",
			retry: "Retry",
			close: "Close",
		},
		"zh-CN": {
			installerTitle: "MusePi 安装程序",
			windowTitle: "MusePi 安装程序",
			minimize: "最小化",
			closeButton: "关闭",
			version: "版本 {version}",
			languageTitle: "选择语言",
			languageLede: "用于安装过程与应用首次启动。之后可随时在设置中更改。",
			perUser: "逐用户安装 · 无需管理员权限",
			continue: "继续",
			locationTitle: "选择安装位置",
			locationLede: "安装到本机后可用桌面快捷方式启动。配置与会话数据单独存放，卸载时保留。",
			targetFolder: "目标文件夹",
			browse: "浏览…",
			desktopShortcut: "创建桌面快捷方式",
			startMenu: "添加到开始菜单",
			back: "上一步",
			install: "安装",
			progressTitle: "正在安装",
			preparing: "正在检查安装环境…",
			awaitingInstaller: "正在启动安装…",
			writingFiles: "正在写入应用文件…",
			cancelling: "正在取消安装…",
			bytesWrittenKb: "已写入 {size} KB",
			bytesWritten: "已写入 {size} MB",
			cancel: "取消安装",
			cancelHint: "取消会停止安装并移除本次写入的文件。",
			cancelKeep: "继续安装",
			cancelConfirmLabel: "确认取消",
			doneTitle: "MusePi 已就绪",
			doneLede: "安装已完成。首次启动会引导你选择语言并配置模型服务商。",
			launchNow: "立即启动 MusePi",
			dataLocal: "配置与会话数据保留在本机",
			finish: "完成",
			errorTitle: "安装失败",
			cancelledTitle: "安装已取消",
			cancelledFresh: "本次写入的文件已移除。",
			cancelledUpgrade: "升级未完成，原有文件可能已被部分替换；重新运行安装程序即可修复。",
			failedTitle: "安装失败",
			failedFresh: "安装程序提前退出，本次写入的文件已移除。",
			failedUpgrade: "安装程序提前退出，原有文件可能已被部分替换；重新运行安装程序即可修复。",
			failedSilent: "安装程序没有开始写入文件，请重新运行安装程序。",
			clientRunning: "MusePi 正在运行。请先关闭所有 MusePi 窗口再重试；安装程序不会强制结束你的应用。",
			unknownError: "未知错误",
			errorBack: "返回",
			retry: "重试",
			close: "关闭",
		},
		"zh-TW": {
			installerTitle: "MusePi 安裝程式",
			windowTitle: "MusePi 安裝程式",
			minimize: "最小化",
			closeButton: "關閉",
			version: "版本 {version}",
			languageTitle: "選擇語言",
			languageLede: "用於安裝過程與應用程式首次啟動。之後可隨時在設定中更改。",
			perUser: "個別使用者安裝 · 無需系統管理員權限",
			continue: "繼續",
			locationTitle: "選擇安裝位置",
			locationLede: "安裝到本機後可用桌面捷徑啟動。設定與工作階段資料會單獨存放，解除安裝時保留。",
			targetFolder: "目標資料夾",
			browse: "瀏覽…",
			desktopShortcut: "建立桌面捷徑",
			startMenu: "新增至開始功能表",
			back: "上一步",
			install: "安裝",
			progressTitle: "正在安裝",
			preparing: "正在檢查安裝環境…",
			awaitingInstaller: "正在啟動安裝…",
			writingFiles: "正在寫入應用程式檔案…",
			cancelling: "正在取消安裝…",
			bytesWrittenKb: "已寫入 {size} KB",
			bytesWritten: "已寫入 {size} MB",
			cancel: "取消安裝",
			cancelHint: "取消會停止安裝並移除本次寫入的檔案。",
			cancelKeep: "繼續安裝",
			cancelConfirmLabel: "確認取消",
			doneTitle: "MusePi 已就緒",
			doneLede: "安裝已完成。首次啟動會引導你選擇語言並設定模型供應商。",
			launchNow: "立即啟動 MusePi",
			dataLocal: "設定與工作階段資料保留在本機",
			finish: "完成",
			errorTitle: "安裝失敗",
			cancelledTitle: "安裝已取消",
			cancelledFresh: "本次寫入的檔案已移除。",
			cancelledUpgrade: "升級未完成，原有檔案可能已被部分取代；重新執行安裝程式即可修復。",
			failedTitle: "安裝失敗",
			failedFresh: "安裝程式提前結束，本次寫入的檔案已移除。",
			failedUpgrade: "安裝程式提前結束，原有檔案可能已被部分取代；重新執行安裝程式即可修復。",
			failedSilent: "安裝程式沒有開始寫入檔案，請重新執行安裝程式。",
			clientRunning: "MusePi 正在執行。請先關閉所有 MusePi 視窗再重試；安裝程式不會強制結束你的應用程式。",
			unknownError: "未知錯誤",
			errorBack: "返回",
			retry: "重試",
			close: "關閉",
		},
	};

	function normalise(language) {
		return Object.prototype.hasOwnProperty.call(locales, language) ? language : "en-US";
	}

	function setText(node, text) {
		if (!node) return;
		const target = node.tagName === "INPUT" ? node.parentElement : node;
		if (!target) return;
		const children = target.childNodes;
		if (children && children.length) {
			for (const child of children) {
				if (child.nodeType === 3 && child.nodeValue.trim()) {
					child.nodeValue = text;
					return;
				}
			}
		}
		target.textContent = text;
	}

	function apply(language, doc) {
		const locale = locales[normalise(language)];
		doc.documentElement.lang = normalise(language);
		doc.title = locale.installerTitle;
		for (const [key, selector] of Object.entries(selectors)) {
			setText(doc.querySelector(selector), locale[key]);
		}
		for (const [key, entry] of Object.entries(attributeSelectors)) {
			const node = doc.querySelector(entry[0]);
			if (node) {
				node.setAttribute(entry[1], locale[key]);
				node.setAttribute("title", locale[key]);
			}
		}
		return locale;
	}

	root.MusePiInstallerI18n = { locales, selectors, normalise, apply };
})(globalThis);