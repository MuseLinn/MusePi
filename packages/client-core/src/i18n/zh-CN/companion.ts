export const companion = {
	// ── Builtin pet preset names/descriptions (English source = key) ──
	Boxcat: "纸箱猫",
	"A tiny cat tucked inside a cardboard box for cozy coding sessions.": "蜷在纸箱里的小猫，适合悠闲的编码时光。",
	Capy: "卡皮巴拉",
	"An original emotionally stable capybara with a tiny orange on its head.": "情绪稳定的原创水豚，头顶一颗小橘子。",
	Jiyi: "吉伊",
	"A round white chibi bear with dark chocolate outlines, pink cheeks, tiny limbs, curled ears, and a small pink bear pouch.":
		"圆滚滚的白色小熊，深巧克力描边、粉色脸颊、小短手小短脚、卷卷耳，挂着粉色小熊包。",
	Hachiware: "小八",
	"A tiny Hachiware-inspired desktop pet with white and blue cat markings, bright eyes, and cheerful expressions.":
		"蓝白花纹的小猫咪，大眼睛亮晶晶，元气满满的表情。",
	Usagi: "乌萨奇",
	"A tiny cream rabbit companion based on the provided Usagi reference.": "奶油色的小兔子伙伴。",
	"Han Li": "韩立御剑飞行",
	"A calm, cautious Q-version of Han Li in a dark-cyan Daoist robe, quietly riding his sword.":
		"谨慎淡定的 Q 版韩立，墨青道袍、腰间小绿瓶，御剑低调赶路的修仙者。",
	Doraemon: "哆啦A梦",
	"A compact blue robot-cat pet inspired by Doraemon.": "蓝色机器猫小伙伴。",
	"Noir Webling": "Noir Webling",
	"A tiny monochrome spider detective in a fedora and trench coat.": "戴着软呢帽和风衣的单色蜘蛛侦探。",
	Feixue: "绯雪",
	"A white-haired, red-eyed character from Wuthering Waves, made into a pixel desktop pet.":
		"绯雪，鸣潮中的白发红眼角色，像素风数字宠物。",
	"pet refresh": "刷新列表",
	"pet market": "Petdex 市场",
	"pet market search placeholder": "搜索宠物（名字、动漫、风格）…",
	"pet market install": "安装",
	"pet installed": "已安装",
	"pet market searching": "搜索中…",
	"pet market empty": "没有找到匹配的宠物",
	"pet market error": "Petdex 搜索失败：{reason}",
	"sound effects catalog": "音效库",
	"preview each effect; dimmed ones are not wired to the UI yet": "逐个试听每个音效；变暗的表示尚未接入界面",
	preview: "试听",
	"not wired to the UI yet": "尚未接入界面",
	"send message, approval request": "发送消息、审批请求到达",
	"first message, prompt enhanced": "发送首条消息、提示词优化完成",
	"connect error, approval denied": "连接失败、审批被拒绝",
	"session switch": "切换会话",
	"stop current turn": "停止当前任务",
	"approval granted": "审批通过",
	"tool result arrived": "工具执行结果返回",
	"sound palette": "音效库",
} as const;

/** Key union for the companion (桌宠/伙伴) domain (source of truth). */
export type CompanionKey = keyof typeof companion;
