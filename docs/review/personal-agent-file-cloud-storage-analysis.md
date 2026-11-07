# 个人助理的文件与云存储：comma / dsh-superagent / 小艺 Work 对比与 MusePi 缺口

> 工作文档，不是长期规格。结论稳定后，能力搬进 `docs/capability-seams.md`、`docs/mobile-design.md` 或 ADR，本文删除。
>
> 分析时间：2026-11-06。参考版本：comma `66ab3dc`（2026-10-27 sync）、dsh-superagent-prototype `8c32a9d`、小艺 Work `0.7.6`（本机安装体）。
> 会话与编排那一层见 `docs/review/personal-agent-assistant-session-design.md`；本文只处理「文件怎么存、怎么寻址、怎么跨设备、怎么接云」。
> 方法：读码 + 抽样复核。`路径:行` 是代码锚点；标「推断」的条目没有直接代码证据。comma 路径均相对其仓库根。

---

## 0. 一页结论

1. **文件跨设备 ≠ 会话跨设备。** 云存储解决的是「一份权威字节 + 一个稳定句柄」，不是「多端看到同一屏」。MusePi 的后者已经由 journal 单 seq 解决，别把两件事混成一个架构。
2. **comma 的存储是「S3 兼容 + 自己签 presign」，没有云厂商锁定。** 自托管就是 MinIO；R2 只用于 VM 归档和 e2e 报告，与用户附件无关。
3. **comma 的 blob 不做内容去重，只有 uuid 寻址。** `blob_ref.hash` 存了 sha256，但键是 `blobs/{uuid}`，所以「内容寻址」这件事在 comma 里是缺失的，不是优点。
4. **dsh-superagent 没有对象存储。** 一 Ticket 一目录就是产物边界，长内容一律截断成 `{text, chars, read}` 指针，二进制只有飞书图片能进上下文。它证明「没有云也能跑」，代价是无保留策略、无跨机访问。
5. **小艺 Work 的云盘是一个能力面被收窄的连接器。** 固定根目录 `小艺Work`、9 条命名管道端点、token 永不出主进程、agent 只拿 `fileId`。这是目前看到的最适合「给模型一个云盘」的形状。
6. **MusePi 的三类资产都寻址不到别的机器**：`blob:sha256:<hex>` 是本机全局哈希，`artifact://<n>` 是会话内自增计数器，非图附件是写进 cwd 的普通文件。跨设备一换，句柄全指错。
7. **MusePi 已有的云能力只有「发一个对象给 provider 抓」**（`BlobPublication`），没有 bucket 抽象、没有读回路径、没有配额。
8. **建议顺序**：先把 `FileRef` 与 `attachment.*` RPC 定型（本地后端），再把 `StorageBackend` 做成接缝（S3/MinIO 是第一个远端实现），最后做云盘连接器。云盘连接器是「接别人的盘」，不是「我们自己的存储」。

---

## 1. 三个模型对照

| 维度 | comma | dsh-superagent | 小艺 Work | MusePi 现状 |
| --- | --- | --- | --- | --- |
| 权威字节在哪 | S3（MinIO） | 本机 Ticket 目录 | 华为云盘 + 本地 `cloud-files` 缓存 | 本机 `~/.musepi/agent/blobs` |
| 寻址句柄 | `blob_ref{uuid,hash,size}` + workspace 路径 | 目录路径 + 截断指针 | `fileId` + 云端 path | `blob:sha256:<hex>` / `artifact://<n>` / cwd 相对路径 |
| 去重 | 无（uuid 键） | 无 | 同名同大小才复用 | 有（内容寻址） |
| 上传通道 | `PUT /v1/comma/groups/:gid/files` 流式 | 无（只有飞书图片） | 分片 resume + `Content-Range` | GUI 用 `fs.write(encoding:"base64")` |
| 下载通道 | 后端代理（Range）+ presign 直链 | 无 | `?form=content` | 无（读本地文件） |
| 生命周期 | 未提交上传 600s 清理 | 无 | 手动 | 引用计数 GC |
| 跨设备 | 是（服务端 bucket） | 否 | 是（华为云，按账号） | 否 |

---

## 2. comma：两套文件系统，一条 blob 主干

### 2.1 上传先落 workspace，消息里固化引用

上传走 `PUT /v1/comma/groups/:gid/files?name=&size=`，流式写进 `/uploads/{22 字节 token}-{name}`（`systems/apps/comma_web/lib/comma_web/router.ex:3661`、`systems/apps/comma_core/lib/comma/group_files.ex:58`）。消息正文保留 `{type:"file", path, file_name, blob_ref}`，但**投影给模型时 `blob_ref` 被删掉**（`systems/apps/salix_im/lib/salix_im/conversation_attachments.ex:57,240`）。

这一点很关键：模型只看到 path，blob 是给执行层用的。MusePi 现在是反过来——模型看到 `blob:sha256:`，但没有工具能解析它。

限额是硬编码的：内联 10 MB、流式 512 MB、扩展名白名单（`group_files.ex:6`）。

### 2.2 下载两条路并存，不是二选一

- **鉴权下载**走服务端代理流式转发，支持 `Range` / `206` / `416`（`systems/apps/comma_web/lib/comma_web/attachment_download.ex:19`、`router.ex:3802`）。
- **媒体元素与下载按钮**拿 presign 直链，由 Comma 自己签 SigV4，有效期 1 小时，返回 `{url, expires_at}`（`conversation_attachments.ex:17,89`、`systems/apps/salix_store/lib/salix_store/s3/aws.ex:346`）。

签名之后存储端不再校验会话成员，所以 presign 必须短命。这是「代理还是直链」的正确分工：**能鉴权的走代理，能缓存的走直链**。

### 2.3 归属是三层，不是一层

`group_id` → `agent_id` → `blob_ref{uuid,hash,size}`。用户 composer 上传绑定到 **Group 的 `router_agent_id`**，不是发送者（`conversation_attachments.ex:43`）。blob 命名空间本身是全局的（`systems/apps/salix_store/lib/salix_store/keys.ex:97`），agent 只是授权上下文。

跨 agent 转发不复制字节，只是 `AgentWorkspace.put_ref` 把同一个 ref 挂到接收方 `/.conversation-attachments/{message_id}/{index}-{filename}`（`conversation_attachments.ex:234`）。

### 2.4 没有去重，也没有配额

`blob_ref.hash` 是 sha256，但寻址只用 `blobs/{uuid}`（`systems/apps/salix_store/lib/salix_store/blob.ex:11`）。删除只撤清单，不动 body；唯一的自动清理是未提交的 prepared 上传，600s grace、每 60s 扫一轮、每批 64（`systems/apps/salix_agent/lib/salix_agent/prepared_blob_cleanup.ex:20`）。全仓没有 workspace 级存储配额。

**这一点不要抄。** content-addressed 是正确的方向，comma 在这一点上不如 MusePi 现在做得好。

### 2.5 自托管的替换点很干净

`compose.yaml:68` 直接起 MinIO + 一个建桶容器；`selfhost/configure.py:50` 把 endpoint 写成 `http://minio:9000`。真正的地基是两项能力开关：`atomic_operations: "s3"|"gcp"` 与 `conditional_delete`——`put(if_none_match:"*")` 做 create-once，`put(if_match:etag)` 做 CAS（`systems/apps/salix_store/lib/salix_store/s3.ex:16`）。

所以自托管换厂商只改 `storage.{endpoint,region,bucket,access_key_id,secret_access_key}`。**这就是「对象存储接缝」该长的样子**：不是抽象成 S3 SDK，而是把「需要哪几种原子操作」声明出来，让实现去满足。

---

## 3. dsh-superagent：目录即边界，指针即读模型

- 一 Ticket 一目录一 Session：会话 id `worker-<ticketId>`，目录 `<stateDir>/work/<英文名>-<ticket id 前 12 位>`（`src/executor/dsh.ts:24,56,110`）。`prepare` 只跑一次、10 分钟超时、失败不重试（`dsh.ts:28,247`）。
- 长内容一律截断成 `{text, chars, read}` 指针，靠虚拟资源按需回读（`dsh.ts:113,341`、`src/app/resources.ts:24`）。
- 二进制只有飞书图片会走 attachment service 进上下文，且先检查模型 `inputModalities` 是否含 image（`src/sources/feishu-image.ts:22`）。文档/文件没有下载通道，只给 worker 一条 CLI 指令自己去取。
- Ticket 整份 JSON 存在 SQLite 一行里（`docs/007-architecture.md:452`），没有对象存储，也没有任何删除/保留策略（`:484`）。

**可借的是「指针 + 按需回读」的读模型**：上下文里永远只放引用和摘要，不放字节。MusePi 的 `artifact://` 已经是这个形状，缺的是**引用要能跨会话/跨机解析**。

---

## 4. 小艺 Work：华为云盘是怎么接进来的

安装体：`C:\Program Files\xiaoyiwork-desktop`，Electron，主进程真实入口 `resources/app/out/main/app-qwvg6y3z.js`（82174 行，压缩成长行）。下文 `M:` 指该文件行号。`resources/app/out/main/app-oNwFawlg.js` 是未被引用的旧产物，不要看。

### 4.1 授权：登录态 UAT 是主路径，设备码是旁路

- 登录 scope 本身就含 drive：`openid https://www.huawei.com/auth/drive https://www.huawei.com/auth/drive.xiaoyiwork`（`M:18042`），所以**不需要单独授权弹窗**。
- 设备码 OAuth 是备用通道，四个环境变量齐全才启用：`POST {host}/oauth2/v3/device/code`（`M:18042`）→ 轮询 `/oauth2/v3/token`，`grant_type=device_code`（`M:18127`）→ 二维码 `verificationUri?user_code=&lang=zh-cn`（`M:18067`）。
- 设备码路径**没有 refresh_token**，过期只能重新扫码（`M:18458,18532`）。
- 凭据存 Windows 注册表 `HKCU\Software\<flavor>\keychain\cloud-drive`，值是 safeStorage 加密的 `{s,a,v}` 信封，且 `{service,account}` 绑进密文（`M:18152,18235`）——换 service 复用密文会被拒。
- 401/403 强制换票重试一次；新票仍 401 就判定 client/scope 不匹配（`M:16254`）。用户可见文案：`云空间授权已失效，请退出后重新登录再试`（`M:15961`）。

### 4.2 Drive API 面

| 动作 | 端点 |
| --- | --- |
| 列表 | `GET /drive/v1/files?queryParam=recycled=false and parentFolder='<id>'&fields=files(id,mimeType,fileName,size,editedTime),nextCursor&pageSize=100`（`M:16021`） |
| 容量 | `GET /drive/v1/about?fields=*`，取 `storageQuota.userCapacity/usedSpace`（`M:16219`） |
| 下载 | `GET /drive/v1/files/{id}?form=content`（`M:16045`） |
| 建目录 | `POST /drive/v1/files?autoRename=false`，body `{parentFolder:["root"],fileName,mimeType:"application/vnd.huawei-apps.folder"}`（`M:16621`） |
| 删除 / 重命名 / 移动 | `DELETE` / `PATCH {fileName}` / `PATCH {addParentFolder,removeParentFolder}`（`M:16565`） |
| 上传 | `POST /upload/drive/v1/files?uploadType=resume` → `Location` 解析 `serverId/uploadId` → `PUT` 带 `Content-Range`，308 继续、2xx 完成，末尾补一次 `Content-Length: 0` 收尾（`M:16675`） |

切片由服务端下发，钳制 256 KiB – 64 MiB（`M:16139`）。容量满按错误码 `4039` 特判（`M:15962`）。

Base URL 三级覆盖：环境变量 → 远端 `import.json` 的 `cloud_namespace_drive_base_url` → 内置 `https://driveapis.cloud.huawei.com.cn`（`M:16814`）；直连遇连接错误改走系统代理重试一次（`M:17146`）。

### 4.3 目录结构与缓存

- **只有一层固定目录 `小艺Work`（root 下），不按会话分子目录**（`M:16305,16611`）。多会话同名文件只能靠 `(n)` 后缀，且 root 列表时被强制置顶。
- 本地缓存：`<dataDir>/cloud-files/<conversationId>/`（`M:16360`），下载默认落 `<workspaceRoot>/cloud_drive/`（`M:16364`）。
- 复用条件：目标已存在**且 size 与请求 size 相等**才跳过下载（`M:17287`）；否则写 `.part-<uuid>` 再 rename（`M:16948`）。跨域重定向会丢掉 `Authorization`（`M:16953`）。
- `artifact-index.db` 三张表：`artifact_rows(PK conversation_id+declared_key, origin, resolved_path, status, verified_at, UNIQUE resolved_path)`、`conversation_scan_state`、`artifact_index_meta`（迁移水位）。本机 3 行全 `origin='local'`——云端产物在本地只是 `fileUrlToLocal[url] → localPath` 映射（`M:40763`）。

### 4.4 agent 怎么访问：skill + 命名管道，token 不出主进程

`resources/skills/cloud-drive-win/SKILL.md`：所有操作限制在 `/我的云盘/小艺Work`，**无需任何凭据**。实际调用经 `np://claw-cloud-drive` → `\\.\pipe\claw-cloud-drive`，`Bearer $CLAW_SKILL_TOKEN`（`skills/cloud-drive-win/scripts/claw_pipe_http.py:40`）。

主进程侧是 9 条白名单端点、只允许 POST/GET、**没有 delete**（`M:17829`）。bridge 负责名字→id 解析：`find` 最多翻 20 页；`upload` 未给 `parentId` 时自动在 root 建目录（`M:18567`）。

**这是一个「连接器」而不是「存储后端」**：agent 拿到的是 `fileId`，要读内容必须先 download；它不参与会话存储，也不承担缓存一致性。

### 4.5 多设备：靠云端会话镜像，不靠本机同步

- 云 WS：`wss://hag-drcn.op.dbankcloud.com/celia-ws/v1/agent/message`，握手带 `businessCredential` + `x-uid` + `x-device-id`（`M:30620`），建连即发 `{msgType:"clawd_bot_init"}`，心跳带全量 `cronList`（`M:30500`）。
- 每条上行帧被就地注入 `uid / sandboxType:"sandbox_pc" / hostname / deviceId / workSpaces / allowMobileConnect`（`M:30491`）。`channel.getMobileConnect` 只是这个开关的读写（`M:23261`）。
- `cloud-chat.json` 是会话镜像：`conversations[] + messages{convId:[]} + readSeqByConvId + fileUrlToLocal`（`M:40292`）。
- `mobile.listConversations` 直接 `return []`（`M:23426`）——手机侧不读本地库，会话只来自云端 `syncTopicUpdate`。
- `multiUserV1` 是一次性迁移：把 `cloud-chat.json / workspaces.json / downloads / cloud-files` 搬进 `users/<uidKey>/`，marker 写 `migrations.json`（`M:81349,81377`）。这是「一台机器多账号」的隔离，不是多人协作。

### 4.6 可借鉴 3 点 / 坑 3 点

**借**
1. 能力面收窄：9 条端点 + 白名单 + token 不出主进程，agent 只拿 id。比给模型一个通用 HTTP 客户端安全得多。
2. 云产物以「URL 即真身 + 本地映射」做缓存真相，配后台 backfill；403/410 判为签名过期、不重试（`M:41975`）。
3. 信封加密把 `{service,account}` 绑进密文，换 service 复用密文会被拒（`M:18235`）。

**坑**
1. 设备码路径无 refresh_token，过期只能重扫码。
2. 列表被服务端 `queryParam` 校验拦下返回 400 时，代码**当空目录吞掉**（`M:16291`）——用户看到「云盘是空的」而不是报错。
3. 单层固定目录 + 无嵌套 mkdir，多会话文件归属只能靠命名约定，必冲突。

---

## 5. MusePi 现状

### 5.1 三类资产，三种寻址，都不能跨机

| 资产 | 落盘 | 句柄 | 解析者 |
| --- | --- | --- | --- |
| 图片/视频/生成图 | `~/.musepi/agent/blobs/<sha256>`（`packages/utils/src/dirs.ts:849`） | `blob:sha256:<64hex>`（`session/blob-store.ts:6,102`） | `session-loader.ts` 加载时还原成 base64 |
| 工具大输出 | `<sessions>/<id>/artifacts/<n>.<tool>.log`（`session/artifacts.ts:93`） | `artifact://<n>`，`n` 每会话自增 | `internal-urls/artifact-protocol.ts:39`，先钉调用方目录再回退遍历 |
| 非图附件 | 会话 cwd `attachments/<name>` | 纯文本 `[Attachment] <relpath>` | 模型自己 `read` |

唯一有「全局唯一 + 可校验」性质的是 blob 的 sha256；但它外面套的是本机绝对路径，没有主机/租户维度。`artifact://3` 在另一台设备上会指向另一个会话的第 3 个产物——注释里已经写明了这个风险（`artifact-protocol.ts:42`）。

### 5.2 上传与下载都不存在协议面

- 图片以 base64 内联进 `session.send.images`，只有 `{type,data,mimeType}`，**没有 url 形态**（`daemon/server.ts:4540`）；视频反而允许 `url`。
- 其他文件由 GUI 用 `fs.write(encoding:"base64")` 写进 cwd（`packages/desktop-app/src/components/composer/use-attachments.ts:12,195`），prompt 里只多一行 `[Attachment] attachments/x.pdf`。
- 下载就是 `fs.readBytes`，8 MiB / 32 MiB 帽（`daemon/services/file-service.ts:129`）。

也就是说：**附件是「借文件系统走私」，不是一等协议对象**。这带来三个后果——没有进度、没有断点续传、没有跨设备。

### 5.3 会话权威已经是对的

journal 是 append-only JSONL，`seq` 从 1 单调，重启从尾部续号（`daemon/journal.ts:163,177,229`）；2000 事件或 4 MiB 触发 checkpoint（`:37`），`catchupPlan` 用 checkpoint/tail 判定强制 resync（`:76`）。SQLite 只是快照锚与查询投影，非权威（`daemon/view-store.ts:15`）。

这块不用动。**文件层只要跟上同一个 seq 语义即可**：附件变化也应该是会话日志里的一条 entry，而不是游离在 cwd 里的文件。

### 5.4 云能力只有「发单对象」

`BlobPublication{url, destination, bytes, expiresAt?, delete?, remoteId?}`（`blob-broker/publication.ts:16`）。目的地覆盖 S3/R2/GCS/Azure/B2/GDrive，但入口是 `images.urls.backends`——产物是**给 provider 抓的临时 URL**，不是可读回的存储。

没有 `list/get/delete` 的回读路径，没有目录概念，没有共享 ACL，没有版本。所以它不能当附件后端用。

---

## 6. 缺口清单

| 优先级 | 缺口 | 证据 | 影响 |
| --- | --- | --- | --- |
| P0 | `artifact://<n>` 只在本机、本会话可解析 | `internal-urls/artifact-protocol.ts:39` | 换设备或换会话后引用指向错误文件 |
| P0 | 附件没有协议面的上传/下载 | `use-attachments.ts:195`；`daemon/server.ts:4540` | 无进度、无续传、无跨设备；GUI 权限等于文件系统权限 |
| P0 | `session.send.images` 只接受 base64 | `daemon/server.ts:4540` | 远端已有文件必须整份塞进消息 |
| P1 | 没有存储接缝：BlobStore 直接吃绝对路径 | `session/blob-store.ts:100`；`dirs.ts:849` | 无法换后端，无法加租户前缀 |
| P1 | 云发布不可读回 | `blob-broker/publication.ts:16` | 不能当附件后端，只能用于 provider 抓图 |
| P1 | GC 只扫本机会话 | `cli/gc-cli.ts:325` | 接云后 A 设备写入的 blob 会被 B 设备的 GC 误删（推断） |
| P2 | 无配额、无 artifact 目录 GC | `session/artifacts.ts:93` | 长期使用磁盘无上界 |
| P2 | `fs.read/readBytes/stat` 接受任意绝对路径 | `daemon/services/file-service.ts:114` | 移动端/IM 场景下读边界比写边界宽 |
| P2 | 非图附件没有元数据（mime/size/hash 不落 entry） | `use-attachments.ts:195` | 无法去重、无法校验、无法在别的端预览 |

---

## 7. 建议

### 7.1 先把「文件句柄」做成全局可寻址的（P0）

```ts
type FileRef =
  | { scheme: "blob"; hash: string; size: number; mime: string; name?: string }
  | { scheme: "artifact"; sessionId: string; seq: number }
  | { scheme: "workspace"; sessionId: string; path: string };
```

三件事必须同时成立：

1. `artifact://` 的 URL 形态改成 `artifact://<sessionId>/<seq>`（旧形态保留只读解析）。现在的「先钉调用方目录」是靠隐式上下文补救，跨端必错。
2. 消息里所有附件引用都写 `FileRef`，不再写裸路径或裸 base64。`blob:` 前缀保留，但语义从「本机路径别名」升级为「内容哈希」。
3. 新增 `attachment.put/get/stat/list` RPC：流式、支持 `Range`、返回 `FileRef`。GUI 与 IM 都走它，`fs.write(encoding:"base64")` 这条走私通道下线。

**为什么这是第一步**：它不依赖任何云端决定。本地后端也能立刻获益（跨会话引用、IM 出站附件、移动端预览）。

### 7.2 再把存储做成接缝（P1）

不要抽象成「S3 SDK 包装」，按 comma 的做法抽象成**能力声明**：

```ts
interface StorageBackend {
  put(key: string, bytes: ReadableStream | Uint8Array, opts?: { ifNoneMatch?: "*" }): Promise<{ etag: string }>;
  get(key: string, opts?: { range?: { start: number; end?: number } }): Promise<ReadableStream>;
  stat(key: string): Promise<{ size: number; etag: string } | null>;
  delete(key: string): Promise<void>;
  signedUrl?(key: string, ttlSeconds: number): Promise<{ url: string; expiresAt: number }>;
  readonly capabilities: { conditionalPut: boolean; conditionalDelete: boolean; serverSideCopy: boolean };
}
```

本地实现就是现在的 BlobStore（`capabilities` 全 true）；远端第一个实现用 S3/MinIO，因为 comma 已经验证了「create-once + CAS + 条件删除」这三件事足够撑起清单语义。

对象键建议：`blobs/<sha256>`（**保留内容寻址**，这是 MusePi 相对 comma 的既有优势），ACL 放旁表而不是键前缀。理由：

- 键前缀分租户会让跨用户去重失效，且以后迁移要重写所有 key。
- comma 也是全局 blob 命名空间 + agent 侧授权（`keys.ex:97`）。
- 代价：需要一个 `blob_refs(hash, ownerId, refCount, lastSeenAt)` 旁表，GC 以它为准。

### 7.3 云盘连接器要按「连接器」而不是「后端」设计（P2）

小艺 Work 的形状可以直接搬：

- token 只存在 daemon（现在有 safeStorage / 凭据管理器可用），工具只拿 `fileId`。
- 固定根目录，只暴露 list/space/find/mkdir/upload/download/rename/move，**不给 delete**。
- 走已有 connector / capability-seam 注册，不新增独立运行时。
- 语义上它是「外部盘」，文件被引用时先 materialize 到本地 cache、再产生 `FileRef`，而不是让模型直接读远端字节。

### 7.4 不要把云存储当同步层

comma 的会话权威是 DB + S3 段式日志，客户端只是投影；MusePi 的权威已经是 journal。**再接一套云端会话库会造成双写冲突**。正确的边界是：

- 会话：journal + seq（现状）。
- 文件：`FileRef` + 存储后端。
- 两者通过「会话日志里的 attachment entry」关联，而不是各自有版本。

### 7.5 多用户要现在留位，但不要现在做

要考虑的只有一件事：`FileRef` 里不要塞本机绝对路径，对象键不要假设单租户。其它（配额、按用户限流、审计）都可以后补。

### 7.6 单条 RPC 的上限怎么绕

现状是两道同值的闸：

- Unix socket / 命名管道：换行分隔的 JSON，接收缓冲是 **JS 字符串**，超过 `MAX_REQUEST_BYTES = 16 MiB` 直接回 `-32600`（`packages/coding-agent/src/daemon/server.ts:9224`）。
- WebSocket：文本帧超过同一常量同样拒绝（`daemon/ws-transport.ts:252`）。

所以内联 base64 附件实际上限约 12 MiB（base64 膨胀 4/3，再加 JSON 外壳）。四条路，按性价比排：

**A. `attachment.putFile({ path })`——同机零传输（已实现）**

桌面端本来就能通过 `electronAPI.getDroppedFilePath` 拿到本地路径（视频附件已经在用）。让运行时自己读盘、自己哈希，字节根本不进 RPC。没有新能力面：`fs.readBytes` 本来就接受任意绝对路径，同一信任域。剪贴板 blob 和读不到的路径回退到内联。

**B. 分片上传——给远程/移动端（已实现）**

`attachment.begin({ name, mimeType, size })` → `{ uploadId, chunkSize }`；`attachment.chunk({ uploadId, index, content })`；`attachment.commit({ uploadId })` → 同一个 `{ ref, url }`；`abort` 清理。chunk 取 3 MiB 原文（4 MiB base64），远低于 16 MiB 闸。第 n 片写在 `n × chunkSize`，所以除最后一片外必须写满；commit 拒绝空洞与大小不符，临时文件不进入 blob 目录。TTL 10 分钟、同时最多 4 个，`stop()` 全部丢弃。

**现状**：本地客户端走 `putFile`（零传输），远程客户端走分片；两条路都落到同一个内容寻址存储，引用形态一致。

**C. WS 二进制帧**

省掉 base64 的 33% 和编解码，但要求协议增加二进制 opcode 语义，且只覆盖 WS 客户端（Unix socket 仍是文本行）。收益不足以抵协议复杂度。

**D. 回环 HTTP 上传**

`startDaemonWeb` 已经是一个带 Origin 围栏的 `Bun.serve`，插件路由表可以挂 `POST /attachments` 并流式读 body（`daemon/static-web.ts:206`、`daemon/web-routes.ts`）。吞吐最好、天然支持 Range，但只在 `webPort` 开启时存在，且要自己管 token；适合将来做「大文件上传 + 断点续传」，不适合作为唯一通道。

**不建议**：直接调大 `MAX_REQUEST_BYTES`。接收侧是字符串拼接，涨上去就是把内存钉在一条连接上，而且帧栅栏是 WS 与 socket 共用的契约。

对照参考实现：kimi-code 的附件上传走进程内 harness（`harness.uploadFile`），根本没有传输层，所以它能把「粘贴即上传 + 暂存 TTL + 提交时短暂等待 + 失败回退内联」做成后台流程（`apps/kimi-code/src/tui/controllers/editor-keyboard.ts:600`、`utils/image-attachment-store.ts:60`）。MusePi 是进程外 daemon，同样的问题必须由协议解决——但**粘贴即上传**这个时机选择值得抄：现在是在发送时同步上传，大文件会把发送卡住。


---

## 8. 分阶段

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| A（约 1 周） | `FileRef` 类型；`artifact://<sessionId>/<seq>`；`attachment.put/get/stat` 本地后端；消息里的附件引用改写 | 同一会话内 `artifact://` 在新端可解析；IM 能发出一张图和一个 PDF；`artifact://3` 在两会话间不串 |
| B（1–2 周） | `StorageBackend` 接缝；S3/MinIO 实现；多机 GC 改为以 `blob_refs` 为准 | 两台机器读同一个 `blob:sha256:`；GC 不误删远端写入的 blob |
| C（1–2 周） | 云盘连接器（先选一个：华为云盘 / OneDrive / Google Drive）；token 在 daemon；固定根目录；materialize 到 cache | agent 能在不接触 token 的前提下列目录、下载一个文件并用 `read` 打开 |
| D（可选） | 附件预取与本地缓存淘汰；presign 直链给移动端 | 移动端预览大图不走 base64 |

---

## 9. 未确认

- **小艺 Work 注册表键是否真的写入**：只确认了写代码路径，没有 `reg query` 读密文。
- **设备码 OAuth 在本机是否启用**：bundle 内没有任何地方给 `CLOUD_DRIVE_*` 赋值，推断为联调/测试通道。
- **comma 生产主桶是 AWS 还是 R2**：示例配置无法判定；bucket CORS 只出现在文档，不在仓库。
- **comma 的「纯局域网完全可用」**：still.fail 上游文档如此声明，Comma 产品层（S3 会话、搜索、附件）未找到对应离线降级实现——推断不成立。
- **MusePi GC 在接云后的实际误删路径**：未跑验证，仅从 `gc-cli.ts:325` 的扫描范围推断。

---

## 10. 附录：关键锚点

**comma**

- `systems/apps/comma_core/lib/comma/group_files.ex:6,58` — 上传限额与流式落盘
- `systems/apps/salix_im/lib/salix_im/conversation_attachments.ex:43,57,89,234` — 归属、投影剥离 blob_ref、presign、跨 agent 挂载
- `systems/apps/comma_web/lib/comma_web/attachment_download.ex:19` — Range 代理
- `systems/apps/salix_store/lib/salix_store/s3.ex:16` — create-once / CAS / 条件删除
- `systems/apps/salix_store/lib/salix_store/blob.ex:11`、`keys.ex:97` — uuid 键、全局命名空间
- `systems/apps/salix_agent/lib/salix_agent/prepared_blob_cleanup.ex:20` — 唯一自动清理
- `compose.yaml:68`、`selfhost/configure.py:50` — MinIO 替换点

**dsh-superagent**

- `src/executor/dsh.ts:24,56,113,247,341` — Ticket 目录、指针、prepare 一次性
- `src/sources/feishu-image.ts:22` — 唯一的二进制入口与 modality 校验
- `docs/007-architecture.md:452,484` — SQLite 存整份 Ticket、无保留策略

**小艺 Work**（`M = resources/app/out/main/app-qwvg6y3z.js`）

- `M:15950-15962` — base URL、固定目录、分片边界、4039
- `M:16021,16045,16219,16565,16621` — Drive CRUD
- `M:16675` — 分片上传 resume
- `M:16360,16364,17287,16948` — 缓存目录、size 复用、`.part` 落盘
- `M:17829` — 管道白名单 9 条、无 delete
- `M:18042,18127,18152,18235,18458` — scope、设备码、注册表信封、无 refresh
- `M:30491,30500,30620,40292,81349` — 多设备 WS、会话镜像、multiUserV1
- `resources/skills/cloud-drive-win/SKILL.md` — skill 契约

**MusePi**

- `packages/coding-agent/src/session/blob-store.ts:6,100` — 内容寻址
- `packages/coding-agent/src/internal-urls/artifact-protocol.ts:39` — 会话内计数器
- `packages/coding-agent/src/session/artifacts.ts:93` — 溢出落盘
- `packages/coding-agent/src/daemon/journal.ts:37,76,163` — seq 与 checkpoint
- `packages/coding-agent/src/daemon/services/file-service.ts:114,129` — 读写边界
- `packages/desktop-app/src/components/composer/use-attachments.ts:12,195` — base64 走私
- `packages/coding-agent/src/blob-broker/publication.ts:16` — 单对象发布
- `packages/coding-agent/src/cli/gc-cli.ts:325` — 本机引用计数 GC
