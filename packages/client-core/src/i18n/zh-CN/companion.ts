export const companion = {
	// ── Builtin pet preset names/descriptions (English source = key) ──
	"companion.boxcat": "纸箱猫",
	"companion.tinyCatTucked.info": "蜷在纸箱里的小猫，适合悠闲的编码时光。",
	"companion.capy": "卡皮巴拉",
	"companion.originalEmotionallyStable.info": "情绪稳定的原创水豚，头顶一颗小橘子。",
	"companion.jiyi": "吉伊",
	"companion.roundWhiteChibi.desc":
		"圆滚滚的白色小熊，深巧克力描边、粉色脸颊、小短手小短脚、卷卷耳，挂着粉色小熊包。",
	"companion.hachiware": "小八",
	"companion.tinyHachiwareInspired.info":
		"蓝白花纹的小猫咪，大眼睛亮晶晶，元气满满的表情。",
	"companion.usagi": "乌萨奇",
	"companion.tinyCreamRabbitCompanion": "奶油色的小兔子伙伴。",
	"companion.hanLi": "韩立御剑飞行",
	"companion.calmCautiousQ.info":
		"谨慎淡定的 Q 版韩立，墨青道袍、腰间小绿瓶，御剑低调赶路的修仙者。",
	"companion.doraemon": "哆啦A梦",
	"companion.compactBlueRobotCat": "蓝色机器猫小伙伴。",
	"companion.noirWebling": "Noir Webling",
	"companion.tinyMonochromeSpiderDetective": "戴着软呢帽和风衣的单色蜘蛛侦探。",
	"companion.feixue": "绯雪",
	"companion.whiteHairedRed.info":
		"绯雪，鸣潮中的白发红眼角色，像素风数字宠物。",
	"companion.petRefresh": "刷新列表",
	"companion.petMarket": "Petdex 市场",
	"companion.petMarketSearchPlaceholder": "搜索宠物（名字、动漫、风格）…",
	"companion.petMarketInstall": "安装",
	"companion.petInstalled": "已安装",
	"companion.petMarketSearching": "搜索中…",
	"companion.petMarketEmpty": "没有找到匹配的宠物",
	"companion.petMarketError": "Petdex 搜索失败：{reason}",
	"companion.soundEffectsCatalog": "音效库",
	"companion.previewEachEffect.info": "逐个试听每个音效；变暗的表示尚未接入界面",
	"companion.preview": "试听",
	"companion.notWiredUiYet": "尚未接入界面",
	"companion.sendMessageApprovalRequest": "发送消息、审批请求到达",
	"companion.firstMessagePromptEnhanced": "发送首条消息、提示词优化完成",
	"companion.connectErrorApprovalDenied": "连接失败、审批被拒绝",
	"companion.sessionSwitch": "切换会话",
	"companion.stopCurrentTurn": "停止当前任务",
	"companion.approvalGranted": "审批通过",
	"companion.toolResultArrived": "工具执行结果返回",
	"companion.soundPalette": "音效库",
} as const;

/** Key union for the companion (桌宠/伙伴) domain (source of truth). */
export type CompanionKey = keyof typeof companion;
