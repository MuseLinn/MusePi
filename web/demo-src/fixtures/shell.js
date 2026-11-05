/**
 * Shell fixtures: the daemon answers the desktop shell needs before any
 * session exists (version, settings, modes, extensions, cron, pause state).
 *
 * Shapes are copied from a real daemon running on an isolated config root, so
 * the renderer parses exactly what it parses in production. Values are demo
 * data — no paths or names from a real machine.
 */

const MODES = [
	{
		id: "chat",
		builtin: true,
		label: "对话模式",
		description: "极简对话：仅内置核心工具",
		extends: [],
		extensions: [],
		hasPrompt: false,
		promptComplete: false,
		settingsKeys: [],
	},
	{
		id: "creator",
		builtin: true,
		label: "创作模式",
		description: "原型、演示稿与内容创作",
		extends: [],
		extensions: [],
		hasPrompt: false,
		promptComplete: false,
		settingsKeys: [],
	},
	{
		id: "design",
		builtin: true,
		label: "设计模式",
		description: "界面与交互设计",
		extends: [],
		extensions: [],
		hasPrompt: false,
		promptComplete: false,
		settingsKeys: [],
	},
	{
		id: "work",
		builtin: true,
		label: "工作模式",
		description: "日常开发与任务推进",
		extends: [],
		extensions: [],
		hasPrompt: false,
		promptComplete: false,
		settingsKeys: [],
	},
];

const EXTENSIONS = {
	extensions: [
		{
			id: "skill:musepi-help",
			kind: "skill",
			name: "musepi-help",
			displayName: "MusePi 帮助",
			description: "回答 MusePi 自身的使用问题",
			state: "active",
			enabled: true,
		},
		{
			id: "skill:board-design",
			kind: "skill",
			name: "board-design",
			displayName: "看板设计",
			description: "生成与调整看板结构",
			state: "active",
			enabled: true,
		},
	],
};

export const methods = {
	"system.ping": () => ({ ok: true }),
	"system.meta": () => ({
		version: "0.7.1",
		musepiVersion: null,
		engineVersion: "0.7.1",
		engine: "MusePi 0.7.1",
		dataRoot: "/home/musepi",
		configDir: "/home/musepi/.config/musepi",
		runtime: "Bun",
	}),
	"system.prewarmStart": () => ({}),
	"setup.status": () => ({
		model: "ready",
		providers: { oauthLoggedIn: false, apiConfigured: true, customCount: 0 },
		modes: { count: MODES.length },
		extensions: { active: EXTENSIONS.extensions.length, disabled: 0 },
	}),
	"extensions.list": () => EXTENSIONS,
	// The welcome composer's picker reads a catalog; the demo has no providers,
	// and anything but an array breaks its model seeding.
	"models.listAvailable": () => [],
	"cron.list": () => ({ tasks: [], runs: [] }),
	"modes.list": () => ({ modes: MODES }),
	"modes.getDefault": () => ({ id: "work" }),
	"daemon.pauseStatus": () => ({ paused: false, pausedAt: null }),
	// Panels reachable from the shell: empty answers keep their empty states
	// instead of a `{}` that the components iterate as an array.
	"remote-access.status": () => ({ hosting: false }),
	"channels.list": () => [],
	"channels.plugins": () => [],
	"design.systems.list": () => ({ systems: [] }),
	"board.list": () => ({ boards: [] }),
	"browser.managedBridge": () => ({ url: null }),
	"settings.get": () => ({
		modelRoles: {},
		cycleOrder: ["smol", "default", "slow"],
		knownRoleIds: ["default", "smol", "slow", "vision", "plan", "designer", "commit", "tiny", "task", "advisor"],
	}),
	"events.subscribe": () => ({ subscriptionId: "demo" }),
	"changelog.startup": () => ({ show: false }),
};
