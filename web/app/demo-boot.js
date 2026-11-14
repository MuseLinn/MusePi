(()=>{var A=new Map,S=new Set;function K(t,e){A.set(t,e)}function u(t){for(let[e,s]of Object.entries(t))K(e,s)}function j(t,e){let s=A.get(t);if(s)return Promise.resolve().then(()=>s(e??{}));if(typeof t==="string"&&t.includes("list"))return Promise.resolve([]);return Promise.resolve({})}var y=1,b=3;class p extends EventTarget{constructor(t){super();this.url=String(t),this.readyState=0,this.binaryType="arraybuffer",this.bufferedAmount=0,this.protocol="",this.extensions="",this.onopen=null,this.onmessage=null,this.onerror=null,this.onclose=null,S.add(this),setTimeout(()=>{if(this.readyState!==0)return;this.readyState=y;let e=new Event("open");if(this.dispatchEvent(e),typeof this.onopen==="function")this.onopen.call(this,e)},16)}deliver(t){if(this.readyState!==y)return;let e=new MessageEvent("message",{data:JSON.stringify(t)});if(this.dispatchEvent(e),typeof this.onmessage==="function")this.onmessage.call(this,e)}send(t){let e;try{e=JSON.parse(String(t))}catch{return}if(location.search.includes("debug")){let s=document.documentElement;s.dataset.demoRpc=`${s.dataset.demoRpc??""} ${e.method}`.trim().slice(-400)}if(e.id===void 0)return;j(e.method,e.params).then((s)=>this.deliver({jsonrpc:"2.0",id:e.id,result:s}),(s)=>this.deliver({jsonrpc:"2.0",id:e.id,error:{code:-32000,message:String(s?.message??s)}}))}close(){if(this.readyState===b)return;this.readyState=b,S.delete(this);let t=new CloseEvent("close",{code:1000,reason:"demo"});if(this.dispatchEvent(t),typeof this.onclose==="function")this.onclose.call(this,t)}}p.CONNECTING=0;p.OPEN=y;p.CLOSING=2;p.CLOSED=b;function N({url:t="ws://127.0.0.1:9/demo"}={}){try{localStorage.setItem("musepi-gui-url",t)}catch{}window.WebSocket=p}var v={};var D=["docs","src"],g=new Map([["README.md",{mtime:1792997600000,content:`# 星轨手账

记录每次观星计划的小工具：挑目标、估算可见窗口，再把它们写进当晚的清单。

## 快速开始

\`\`\`bash
bun install
bun run dev
\`\`\`

## 目录

| 路径 | 说明 |
| --- | --- |
| \`src/app.ts\` | 命令行入口：读取星表并排期 |
| \`src/schedule.ts\` | 可见窗口计算与排序 |
| \`docs/notes.md\` | 设计笔记与取舍记录 |
| \`package.json\` | 脚本与依赖 |

> 这里的文件来自演示 daemon 的内存，不会读写你的磁盘。
`}],["package.json",{mtime:1792994600000,content:`{
	"name": "orbit-notes",
	"private": true,
	"type": "module",
	"scripts": {
		"dev": "bun run src/app.ts",
		"test": "bun test"
	}
}
`}],["src/app.ts",{mtime:1792999280000,content:`import { schedule } from "./schedule";

interface Target {
	name: string;
	ra: number;
	dec: number;
}

const targets: Target[] = [
	{ name: "M31", ra: 0.712, dec: 41.27 },
	{ name: "M42", ra: 5.588, dec: -5.39 },
	{ name: "M13", ra: 16.695, dec: 36.46 },
];

const tonight = schedule(targets, { start: "20:30", end: "23:45" });

for (const slot of tonight) {
	console.log(\`\${slot.start}  \${slot.target.name}  \${slot.altitude}°\`);
}
`}],["src/schedule.ts",{mtime:1792998440000,content:`interface Target {
	name: string;
	ra: number;
	dec: number;
}

interface Slot {
	start: string;
	target: Target;
	altitude: number;
}

/** Upper culmination at 20:30 local: a target is visible while its hour angle
 *  stays inside ±2h and it clears the 20° haze band. */
const MIN_ALTITUDE = 20;
const WINDOW_MINUTES = 240;

function altitudeAt(target: Target, minutes: number): number {
	const hourAngle = (minutes / 60 - (target.ra * 15 + 20.5)) % 24;
	const folded = Math.abs(hourAngle) > 12 ? 24 - Math.abs(hourAngle) : Math.abs(hourAngle);
	return 90 - Math.abs(target.dec) - folded * 15;
}

export function schedule(targets: Target[], night: { start: string; end: string }): Slot[] {
	const [startH, startM] = night.start.split(":").map(Number);
	const [endH, endM] = night.end.split(":").map(Number);
	const from = startH * 60 + startM;
	const to = endH * 60 + endM;

	return targets
		.map(target => {
			const minutes = from + WINDOW_MINUTES / 2;
			return { target, minutes, altitude: Math.round(altitudeAt(target, minutes)) };
		})
		.filter(slot => slot.altitude >= MIN_ALTITUDE && slot.minutes <= to)
		.sort((a, b) => b.altitude - a.altitude)
		.map(slot => ({
			start: \`\${String(Math.floor(slot.minutes / 60)).padStart(2, "0")}:\${String(slot.minutes % 60).padStart(2, "0")}\`,
			target: slot.target,
			altitude: slot.altitude,
		}));
}
`}],["docs/notes.md",{mtime:1792989200000,content:`# 设计笔记

## 为什么先做排期，而不是星图

排期只需要赤经赤纬和观测地坐标，一小时就能算完；星图要渲染、要缩放、
要对齐星等，投入大得多。先用排期验证「今晚看什么」这个真问题。

## 取舍

- 目标数量上限 20 个：再多一个晚上也看不完。
- 高度角低于 20° 直接跳过，大气抖动太大。
- 不做自动寻星，只输出时间与方位角，剩下的交给赤道仪。
`}]]),F={md:"text/markdown",json:"application/json",ts:"text/plain"};function U(t){let e=t.lastIndexOf(".");return e===-1?"application/octet-stream":F[t.slice(e+1)]??"application/octet-stream"}function M(t){let e=String(t??"").replace(/\\/g,"/").replace(/\/+$/,"");if(e==="/home/musepi/Projects/atlas")return"";if(!e.startsWith("/home/musepi/Projects/atlas/"))return null;return e.slice(28)}function C(t){return new TextEncoder().encode(t)}function q(t){let e="";for(let s of t)e+=String.fromCharCode(s);return btoa(e)}function z(){return[...D.map((e)=>({path:e,isDir:!0,size:0,mtime:1792992800000})),...[...g].map(([e,s])=>({path:e,isDir:!1,size:C(s.content).length,mtime:s.mtime}))].map((e)=>({name:e.path.slice(e.path.lastIndexOf("/")+1),path:e.path,isDir:e.isDir,isSymlink:!1,size:e.size,mtime:e.mtime,depth:e.path.split("/").length}))}var X={id:"ws_demo_project",root:"/home/musepi/Projects/atlas",name:"星轨手账",kind:"managed",additionalDirs:[],createdAt:1790408000000,lastOpenedAt:1793000000000},E={"workspace.list":()=>({workspaces:[X]}),"workspace.tree":(t)=>{let e=String(t.root??"").replace(/^\/+|\/+$/g,""),s=(e===""?0:e.split("/").length)+(t.maxDepth??2);return{rootPath:"/home/musepi/Projects/atlas",truncated:!1,entries:z().filter((o)=>e===""||o.path.startsWith(`${e}/`)).filter((o)=>o.depth<=s).sort((o,i)=>o.path.localeCompare(i.path))}},"fs.readBytes":(t)=>{let e=g.get(M(t.path)??"");if(!e)return{error:`ENOENT: no such file or directory, stat '${t.path}'`};let s=C(e.content);return{base64:q(s),size:s.length,mime:U(t.path)}},"fs.read":(t)=>({content:g.get(M(t.path)??"")?.content??null}),"fs.stat":(t)=>{let e=M(t.path),s=e===""||D.includes(e);return{exists:s||g.has(e??""),isDirectory:s}},"git.status":()=>({root:"/home/musepi/Projects/atlas",branch:"main",ahead:0,behind:0,staged:[],unstaged:[]}),"git.branches":()=>({current:"main",branches:["main","demo"]}),"git.identity":()=>({name:"MusePi Demo",email:"demo@musepi.example",source:"global"})};var T=[{id:"chat",builtin:!0,label:"对话模式",description:"极简对话：仅内置核心工具",extends:[],extensions:[],hasPrompt:!1,promptComplete:!1,settingsKeys:[]},{id:"creator",builtin:!0,label:"创作模式",description:"原型、演示稿与内容创作",extends:[],extensions:[],hasPrompt:!1,promptComplete:!1,settingsKeys:[]},{id:"design",builtin:!0,label:"设计模式",description:"界面与交互设计",extends:[],extensions:[],hasPrompt:!1,promptComplete:!1,settingsKeys:[]},{id:"work",builtin:!0,label:"工作模式",description:"日常开发与任务推进",extends:[],extensions:[],hasPrompt:!1,promptComplete:!1,settingsKeys:[]}],R={extensions:[{id:"skill:musepi-help",kind:"skill",name:"musepi-help",displayName:"MusePi 帮助",description:"回答 MusePi 自身的使用问题",state:"active",enabled:!0},{id:"skill:board-design",kind:"skill",name:"board-design",displayName:"看板设计",description:"生成与调整看板结构",state:"active",enabled:!0}]},f={"system.ping":()=>({ok:!0}),"system.meta":()=>({version:"0.7.1",musepiVersion:null,engineVersion:"0.7.1",engine:"MusePi 0.7.1",dataRoot:"/home/musepi",configDir:"/home/musepi/.config/musepi",runtime:"Bun"}),"system.prewarmStart":()=>({}),"setup.status":()=>({model:"ready",providers:{oauthLoggedIn:!1,apiConfigured:!0,customCount:0},modes:{count:T.length},extensions:{active:R.extensions.length,disabled:0}}),"extensions.list":()=>R,"models.listAvailable":()=>[],"cron.list":()=>({tasks:[],runs:[]}),"modes.list":()=>({modes:T}),"modes.getDefault":()=>({id:"work"}),"daemon.pauseStatus":()=>({paused:!1,pausedAt:null}),"remote-access.status":()=>({hosting:!1}),"channels.list":()=>[],"channels.plugins":()=>[],"design.systems.list":()=>({systems:[]}),"board.list":()=>({boards:[]}),"browser.managedBridge":()=>({url:null}),"settings.get":()=>({modelRoles:{},cycleOrder:["smol","default","slow"],knownRoleIds:["default","smol","slow","vision","plan","designer","commit","tiny","task","advisor"]}),"events.subscribe":()=>({subscriptionId:"demo"}),"changelog.startup":()=>({show:!1})};var V=f["extensions.list"],P=null;async function x(t){let e=await fetch(t);if(!e.ok)throw Error(`${t} responded ${e.status}`);return await e.text()}function Q(){return P??=(async()=>{let t=JSON.parse(await x("./plugins/manifest.json"));return await Promise.all(t.components.map(async(e)=>{let[s,a]=await Promise.all([x(`./plugins/${e.code}`),e.css?x(`./plugins/${e.css}`):Promise.resolve(void 0)]);return{slot:e.slot,extensionId:e.extensionId,label:e.label,...e.order!==void 0?{order:e.order}:{},...e.availability?{availability:e.availability}:{},code:s,...a?{css:a}:{}}}))})(),P}var W={"extensions.list":async()=>({...V(),components:await Q()})};var n=Date.now();function d(t){return new Date(t).toISOString()}function I(t,e,s,a){return{id:t,parentId:e,timestamp:d(a),type:"message",message:{role:"user",content:s,timestamp:a}}}function c(t,e,s,a,o="stop",i=[2400,320,18000,0.012]){let[r,l,O,G]=i;return{id:t,parentId:e,timestamp:d(s),type:"message",message:{role:"assistant",content:a,model:"anthropic/claude-sonnet-4-5",usage:{input:r,output:l,cacheRead:O,cacheWrite:0,totalTokens:r+l+O,cost:{total:G}},stopReason:o,timestamp:s}}}function h(t,e,s,a,o,i,r=!1){return{id:t,parentId:e,timestamp:d(s),type:"message",message:{role:"toolResult",toolCallId:a,toolName:o,content:[{type:"text",text:i}],isError:r,timestamp:s}}}function _({id:t,title:e,modeId:s,createdAt:a,updatedAt:o,entries:i}){let r=i[i.length-1];return{id:t,title:e,modeId:s,createdAt:a,updatedAt:o,entries:i,roundDurations:i.filter((l)=>l.type==="message"&&l.message.role==="user").map((l)=>[l.message.timestamp,r.message.timestamp-l.message.timestamp])}}var ee=_({id:"demo-sidebar-groups",title:"设计侧栏分组",modeId:"design",createdAt:n-172800000-10800000,updatedAt:n-1080000,entries:[I("g1",null,"侧栏的会话列表现在是平铺的，帮我按日期分组（今天 / 最近 7 天），并在行上标出未读。",n-2040000),c("g2","g1",n-1980000,[{type:"thinking",thinking:"分组只该影响排序和组标题，行本身的渲染要复用同一个列表组件——先看现在的结构再动。"},{type:"text",text:"先确认现在的列表是怎么组织的：分组应该只包在列表外面，行组件不动。"},{type:"toolCall",id:"call-read-grouped",name:"read",arguments:{path:"apps/desktop/src/components/GroupedSessionList.tsx",limit:40},intent:"读取现有的分组列表"}],"toolUse",[1860,210,12400,0.0091]),h("g3","g2",n-1980000+4000,"call-read-grouped","read",`1  /** Bucket a timestamp into a date-group label. */
2  function dateGroup(ts: string): string {
3  	const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
4  	if (days <= 0) return t("settings.today");
5  	if (days === 1) return t("settings.yesterday");
6  	if (days <= 7) return t("settings.last7Days");
7  	return t("settings.earlier");
8  }`),c("g4","g3",n-1860000,[{type:"text",text:"结构够用，只需要补两处：分组键改用最近活动时间，未读沿用已有的 `messageCount`。"},{type:"toolCall",id:"call-edit-groups",name:"edit",arguments:{path:"apps/desktop/src/components/GroupedSessionList.tsx",old:"const g = dateGroup(n.entry.timestamp)",new:"const g = dateGroup(n.entry.updatedAt ?? n.entry.timestamp)"},intent:"改用最近活动时间分组"}],"toolUse",[2120,268,13800,0.0102]),h("g5","g4",n-1860000+3000,"call-edit-groups","edit",`--- a/apps/desktop/src/components/GroupedSessionList.tsx
+++ b/apps/desktop/src/components/GroupedSessionList.tsx
@@ -67,3 +67,3 @@
-			const g = dateGroup(n.entry.timestamp) || "earlier";
+			const g = dateGroup(n.entry.updatedAt ?? n.entry.timestamp) || "earlier";`),c("g6","g5",n-1800000,[{type:"text",text:'改完了，分组键和未读标记两处：\n\n- 分组键改用 `entry.updatedAt ?? entry.timestamp`，最近有活动的会话才会浮到今天\n- 未读沿用 `session.list` 的 `messageCount`，与已读游标比对，不新增 RPC\n- 空桶不渲染，侧栏不会多出空行\n\n```ts\nconst key = node.entry.updatedAt ?? node.entry.timestamp;\nconst group = dateGroup(key) || "earlier";\n```\n\n侧栏现在只剩两个组：今天和最近 7 天。'}],"stop",[2480,96,15100,0.0108])]}),te=_({id:"demo-review-pr128",title:"审查 PR #128 的 diff",modeId:"work",createdAt:n-172800000-2400000,updatedAt:n-172800000,entries:[I("r1",null,"看下 PR #128 的 diff，重点确认重连退避的上限有没有改。",n-172800000-1560000),c("r2","r1",n-172800000-1500000,[{type:"text",text:"先取完整的 diff，再只盯重连那一段。"},{type:"toolCall",id:"call-pr-diff",name:"bash",arguments:{command:"gh pr diff 128 -- patch",intent:"Fetch PR 128 diff"},intent:"取 PR #128 的 diff"}],"toolUse",[3120,184,21600,0.0128]),h("r3","r2",n-172800000-1500000+6000,"call-pr-diff","bash",`diff --git a/src/net/reconnect.ts b/src/net/reconnect.ts
@@ -12,7 +12,7 @@
-const BACKOFF_MAX_MS = 5_000;
+const BACKOFF_MAX_MS = 30_000;
 
-const delay = Math.min(500 * 2 ** attempt, BACKOFF_MAX_MS);
+const delay = Math.min(1_000 * 2 ** attempt, BACKOFF_MAX_MS);`),c("r4","r3",n-172800000-1440000,[{type:"text",text:`diff 只动了两个常量，没有触碰分支逻辑：

1. 退避上限 5s → 30s
2. 基数 500ms → 1s

\`\`\`ts
const delay = Math.min(1_000 * 2 ** attempt, 30_000);
\`\`\`

需要注意的地方：上限拉长后，前三次重试的间隔变成 1s / 2s / 4s，首帧恢复比以前慢；如果这是为了压住重连风暴，可以接受。`}],"stop",[3480,214,23100,0.0136])]}),se=_({id:"demo-settings-keys",title:"设置页快捷键",modeId:"work",createdAt:n-432000000-7200000,updatedAt:n-432000000,entries:[I("k1",null,"设置页要加一个快捷键编辑区，按键冲突怎么检测？",n-432000000-2880000),c("k2","k1",n-432000000-2820000,[{type:"thinking",thinking:"快捷键注册表是唯一事实来源，冲突检测应该读它而不是自己再维护一张表。"},{type:"text",text:"冲突检测不该另建一张表——键位注册表已经是唯一事实来源，直接读它。"},{type:"toolCall",id:"call-grep-keys",name:"grep",arguments:{pattern:"app\\.session\\.tree|app\\.command\\.palette",path:"packages/coding-agent/src/config"},intent:"查键位注册表结构"}],"toolUse",[1940,152,11200,0.0084]),h("k3","k2",n-432000000-2820000+5000,"call-grep-keys","grep",`packages/coding-agent/src/config/keybindings.ts:43:	"app.session.tree": true;
packages/coding-agent/src/config/keybindings.ts:173:	"app.session.tree": {
packages/coding-agent/src/config/keybindings.ts:267:	tree: "app.session.tree",`),c("k4","k3",n-432000000-2760000,[{type:"text",text:"注册表里每个动作都有默认键位和可覆盖项，检测分两层：\n\n| 层级 | 判据 | 结果 |\n| --- | --- | --- |\n| 同一动作 | 新旧键位相同 | 静默忽略 |\n| 跨动作 | 归一化后的键位相同 | 行内报错，阻止保存 |\n\n归一化只做三件事：小写、按固定顺序排列修饰键、把 `Cmd` 映射成 `Mod`。这样 `Shift+Cmd+K` 和 `Cmd+Shift+K` 才会被判成同一个键位。"}],"stop",[2260,236,12900,0.0096])]}),m=[ee,te,se];function ne(){return m.map((t)=>({entry:{type:"session",id:t.id,parentId:null,subagent:!1,advisor:!1,timestamp:d(t.createdAt),updatedAt:d(t.updatedAt),label:t.title},children:[]}))}function oe(){return m.map((t)=>({id:t.id,parentId:null,kind:"session",subagent:!1,advisor:!1,timestamp:d(t.createdAt),updatedAt:d(t.updatedAt),model:"anthropic/claude-sonnet-4-5",messageCount:t.entries.length,cwd:"/home/musepi/Projects/atlas",modeId:t.modeId,paused:!1,agentCount:0,working:!1,live:!1,status:"complete",title:t.title}))}function ae(t){let e=m.find((s)=>s.id===t);if(!e)return{stream:null,snapshot:{entries:[],cursor:0,state:{isStreaming:!1,queuedMessageCount:0,cwd:"/home/musepi/Projects/atlas",participants:[]}},compactedThrough:!1};return{stream:null,snapshot:{header:{type:"session",id:e.id,timestamp:d(e.createdAt),cwd:"/home/musepi/Projects/atlas",title:e.title,model:"anthropic/claude-sonnet-4-5",modeId:e.modeId},entries:e.entries,state:{isStreaming:!1,queuedMessageCount:0,cwd:"/home/musepi/Projects/atlas",participants:[],goalMode:null,planMode:!1,todo:[],isCompacting:!1,paused:!1,pausedAt:null},agents:[],cursor:e.entries.length,roundDurations:e.roundDurations,structureRev:0,tail:{hasMore:!1,beforeId:null}},compactedThrough:!1}}var ie={"demo-sidebar-groups":{tokens:128400,contextWindow:1e6,percent:13},"demo-review-pr128":{tokens:42600,contextWindow:1e6,percent:4},"demo-settings-keys":{tokens:18900,contextWindow:1e6,percent:2}},L={"session.tree":ne,"session.list":oe,"session.resume":(t)=>ae(t.sessionId),"session.pauseStatus":()=>({paused:!1,pausedAt:null}),"session.contextUsage":(t)=>ie[t.sessionId]??null,"session.thinkingInfo":()=>({ceiling:"high",level:"medium",auto:!1,resolved:null,efforts:["minimal","low","medium","high","xhigh"],model:{id:"claude-sonnet-4-5",name:"Claude Sonnet 4.5",provider:"anthropic"}}),"session.turns":(t)=>{let s=m.find((o)=>o.id===t.sessionId)?.entries??[];return{turns:s.flatMap((o,i)=>{if(o.message?.role!=="user")return[];let r=typeof o.message.content==="string"?o.message.content:"";return[{startIdx:i,entryId:o.id,timestamp:o.timestamp,summary:r.replace(/\s+/g," ").trim().slice(0,90),kind:"user"}]}),totalEntries:s.length,hasMore:!1,remaining:0,nextBeforeTurn:null,stale:!1}}},ce=m.map((t)=>t.id);try{localStorage.setItem("musepi-gui-onboarding-done","1"),localStorage.setItem("omp-collab-theme","dark"),localStorage.setItem("musepi-gui-url","ws://127.0.0.1:9/demo")}catch{}u(f);u(W);u(L);u(E);u(v);N();function k(t){if(window.parent===window)return;window.parent.postMessage({type:t},"*")}function w(){if(document.querySelector(".gui-splash, .gui-connect-wrap"))return!1;return Boolean(document.querySelector(".gui-shell, .gui-workspace-keeper, .gui-main"))}function Y(){if(w()){k("musepi:demo-ready");return}let t=setInterval(()=>{if(!w())return;clearInterval(t),k("musepi:demo-ready")},100);setTimeout(()=>{if(clearInterval(t),!w())k("musepi:demo-failed")},30000)}if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",Y);else Y();})();
