/**
 * Creation surface domain — M3.2 六 tab 创作面板全量文案
 * （docs/review/0.5.0-m3.1-creation-surface-design.md §3/§5）。
 * 面板复用 shell/settings 域既有通用键（如确认/删除按钮语义走
 * DialogFrame 既有键），此处只收创作面新增文案。
 */
export const creation = {
	// 面板骨架
	"creation title": "创建",
	"creation close": "关闭创作面板",
	"creation tab prototype": "原型",
	"creation tab live artifact": "实况产物",
	"creation tab deck": "演示稿",
	"creation tab template": "模板",
	"creation tab media": "媒体",
	"creation tab other": "其他",
	// 公共区块（§3.0）
	"creation project name": "项目名",
	"creation project name placeholder": "未命名项目",
	"creation workspace": "工作目录",
	"creation workspace none": "未选择工作目录",
	"creation pick workspace": "选择目录",
	"creation create button": "创建会话",
	"creation start from": "从模板开始",
	"creation blank": "空白",
	"creation pick project first": "先在欢迎页选择一个项目目录",
	// Prototype（§3.1）
	"creation platform label": "平台",
	"creation platform responsive": "响应式",
	"creation platform web-desktop": "桌面 Web",
	"creation platform mobile-ios": "iOS",
	"creation platform mobile-android": "Android",
	"creation platform tablet": "平板",
	"creation platform desktop-app": "桌面应用",
	"creation fidelity label": "保真度",
	"creation fidelity wireframe": "线框",
	"creation fidelity wireframe desc": "低保真结构示意",
	"creation fidelity high-fidelity": "高保真",
	"creation fidelity high-fidelity desc": "接近成品的视觉",
	"creation surface landing": "包含落地页",
	"creation surface os widgets": "包含 OS 控件",
	// Live Artifact（§3.2）
	"creation live artifact beta": "Beta",
	"creation live artifact desc": "持续演进的实况产物：随会话保持更新，交付物即是产物本身。",
	"creation connectors placeholder": "连接器扩展位（M4.3 落地）",
	// Deck（§3.3）
	"creation speaker notes": "演讲者备注",
	// Template tab（§3.4）
	"creation templates title": "会话模板",
	"creation templates empty": "还没有模板。创建原型或演示稿后，可在创建成功的提示里保存为模板。",
	"creation template apply": "使用此模板创建",
	"creation template delete": "删除",
	"creation template confirm delete": "删除模板「{name}」？此操作不可撤销。",
	"creation template unnamed": "未命名模板",
	// 创建成功 toast 上的保存入口（§3.4）
	"creation saved toast": "会话已创建",
	"creation template save action": "保存为模板",
	"creation template saved": "已保存为模板",
	// Media（§3.5）
	"creation media image": "图片",
	"creation media video": "视频",
	"creation media audio": "音频",
	"creation media model label": "模型",
	"creation media aspect label": "画幅",
	"creation media duration label": "时长",
	"creation media duration sec": "{sec} 秒",
	"creation media audio kind label": "类型",
	"creation media kind speech": "语音",
	"creation media kind sfx": "音效",
	"creation media voice label": "音色",
	"creation media voice placeholder": "音色名，如 warm-female",
	"creation media prompt label": "提示词模板",
	"creation media prompt search": "搜索模板…",
	"creation media prompt placeholder": "描述要生成的画面或声音…",
	"creation media no providers": "暂无可用 provider，请在 设置 → 媒体生成 中配置。",
	"creation media not configured": "未配置",
	"creation media configured": "已配置",
	// 提示词模板内置条目（首版数据源，无后端存储）
	"creation prompt product shot": "产品图",
	"creation prompt product shot body": "为产品拍摄一张棚拍风格图：干净背景、柔和布光、突出材质细节，居中构图。",
	"creation prompt poster": "海报",
	"creation prompt poster body": "设计一张竖版海报：大标题层级清晰、主视觉占 2/3 版面、留白呼吸感强。",
	"creation prompt character": "角色设定",
	"creation prompt character body": "绘制角色三视图设定：正面/侧面/背面，统一光源，附带表情与动作小图。",
	"creation prompt scene": "场景概念",
	"creation prompt scene body": "绘制场景概念图：广角构图、明确景深层级、标注氛围光方向。",
	// Other（§3.6）
	"creation other desc": "通用会话：不进设计 skill 路由，仅保留平台选择。",
} as const;

/** Key union for the creation domain (source of truth). */
export type CreationKey = keyof typeof creation;
