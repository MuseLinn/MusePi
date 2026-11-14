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
		doneTitle: "#h-done",
		doneLede: "#page-done .lede",
		launchNow: "#chk-launch",
		dataLocal: "#page-done .hint",
		finish: "#btn-finish",
		errorTitle: "#h-error",
		unknownError: "#error-message",
		errorBack: "#page-error [data-back]",
		retry: "#btn-retry",
	};

	const attributeSelectors = {
		minimize: ["#btn-min", "aria-label"],
		close: ["#btn-close", "aria-label"],
	};

	const locales = {
		"en-US": {
			installerTitle: "MusePi Setup",
			windowTitle: "MusePi Setup",
			minimize: "Minimize",
			close: "Close",
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
			preparing: "Preparing…",
			handingOff: "Setup is ready. Opening the file installation progress…",
			doneTitle: "MusePi is ready",
			doneLede: "Installation is complete. The first launch helps you choose a language and configure a model provider.",
			launchNow: "Launch MusePi now",
			dataLocal: "Settings and sessions stay on this computer",
			finish: "Finish",
			errorTitle: "Installation failed",
			unknownError: "Unknown error",
			errorBack: "Back",
			retry: "Retry",
			installed: "Installation complete",
		},
		"zh-CN": {
			installerTitle: "MusePi 安装程序",
			windowTitle: "MusePi 安装程序",
			minimize: "最小化",
			close: "关闭",
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
			preparing: "准备中…",
			handingOff: "安装选项已确认，正在打开真实文件安装进度…",
			doneTitle: "MusePi 已就绪",
			doneLede: "安装已完成。首次启动会引导你选择语言并配置模型服务商。",
			launchNow: "立即启动 MusePi",
			dataLocal: "配置与会话数据保留在本机",
			finish: "完成",
			errorTitle: "安装失败",
			unknownError: "未知错误",
			errorBack: "返回",
			retry: "重试",
			installed: "安装完成",
		},
		"zh-TW": {
			installerTitle: "MusePi 安裝程式",
			windowTitle: "MusePi 安裝程式",
			minimize: "最小化",
			close: "關閉",
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
			preparing: "準備中…",
			handingOff: "安裝選項已確認，正在開啟實際檔案安裝進度…",
			doneTitle: "MusePi 已就緒",
			doneLede: "安裝已完成。首次啟動會引導你選擇語言並設定模型供應商。",
			launchNow: "立即啟動 MusePi",
			dataLocal: "設定與工作階段資料保留在本機",
			finish: "完成",
			errorTitle: "安裝失敗",
			unknownError: "未知錯誤",
			errorBack: "返回",
			retry: "重試",
			installed: "安裝完成",
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
