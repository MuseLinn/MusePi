# 文件系统扫描缓存架构契约

[English](fs-scan-cache-architecture.md) | 中文

本文档定义了共享文件系统扫描缓存的当前契约：Rust 实现位于 `crates/pi-natives/src/fs_cache.rs`，由暴露给 `packages/coding-agent` 的原生 discovery/search API 消费。

本文档定义了共享文件系统扫描缓存的当前契约：Rust 实现位于 `crates/pi-natives/src/fs_cache.rs`，由暴露给 `packages/coding-agent` 的原生 discovery/search API 消费。

## 此缓存是什么

缓存按扫描范围、遍历策略和请求的元数据详细程度存储完整的目录扫描条目列表（`GlobMatch[]`）。更上层的操作（`glob` 过滤、`fuzzyFind` 评分，以及缓存的 `grep` 候选选择）都基于这些缓存条目执行。

主要目标：

- 避免对重复的 discovery/search 调用重复执行文件系统遍历
- 当原生 discovery/search 流共享相同扫描策略时保持一致性
- 允许对空结果进行明确的陈旧性恢复，以及在文件变更后显式失效

## 所有权与公开表面

- 缓存实现与策略：`crates/pi-natives/src/fs_cache.rs`
- 原生消费者：
  - `crates/pi-natives/src/glob.rs`
  - `crates/pi-natives/src/fd.rs`（`fuzzyFind`）
  - `crates/pi-natives/src/grep.rs`（仅缓存目录模式）
  - `crates/pi-natives/src/ast.rs`（`astGrep`/`astEdit` 文件发现；始终缓存）
- JS 绑定/导出：
  - `packages/natives/native/index.d.ts`（`invalidateFsScanCache`）
  - `packages/natives/native/index.js`
- Coding-agent 变更失效辅助：
  - `packages/coding-agent/src/tools/fs-cache-invalidation.ts`

## 缓存键分区（硬契约）

每个条目按以下维度键控：

- 规范化的 `root` 目录路径
- `include_hidden` 布尔值
- `use_gitignore` 布尔值
- `skip_node_modules` 布尔值
- `detail`（`ScanDetail::Minimal` 或 `ScanDetail::Full`）

含义：

- 隐藏与非隐藏扫描**不**共享条目。
- 遵循 gitignore 与忽略禁用扫描**不**共享条目。
- 修剪 `node_modules` 的扫描**不**与包含它的扫描共享条目。
- 最小扫描（仅路径 + 文件类型）**不**与完整扫描（mtime + 常规文件大小元数据）共享条目。
- `follow_links` 属于用于构建遍历器的 `ScanOptions`，但当前**不是** `CacheKey` 的一部分；仅因 `follow_links` 不同的调用可以共享缓存条目。

消费者必须对 hidden/gitignore/node_modules/detail 行为传入稳定语义；更改任何键控标志都会创建不同的缓存分区。

## 扫描集合行为

缓存填充使用 `ignore::WalkBuilder`，按 `include_hidden`、`use_gitignore`、`skip_node_modules` 和 `follow_links` 配置：

- 按文件路径排序
- `.git` 始终被修剪
- 当 `skip_node_modules=true` 时，`node_modules` 在遍历时被修剪
- 每次并行访问者访问 128 个条目前检查取消
- `ScanDetail::Minimal` 仅记录规范化相对路径和文件类型
- `ScanDetail::Full` 额外记录 mtime 和常规文件大小

缓存扫描的搜索根由 `fs_cache::resolve_search_path` 解析：

- 相对路径针对当前 cwd 解析
- 目标必须是已存在的目录
- 尽可能规范化 root

## 新鲜度与淘汰策略

全局策略（可被环境覆盖）：

- `FS_SCAN_CACHE_TTL_MS`（默认 `1000`）
- `FS_SCAN_EMPTY_RECHECK_MS`（默认 `200`）
- `FS_SCAN_CACHE_MAX_ENTRIES`（默认 `16`）

行为：

- `get_or_scan(...)`
  - 若 TTL 为 `0`：绕过缓存，始终执行全新扫描（`cache_age_ms = 0`）
  - 在 TTL 内命中缓存：返回克隆的缓存条目 + 非零 `cache_age_ms`
  - 命中过期：淘汰该键，重新扫描，存储新条目
- `force_rescan(..., store=false)`：移除任何匹配的键，全新扫描，**不**重新填充缓存
- `force_rescan(..., store=true)`：移除任何匹配的键，全新扫描，然后存储新条目
- 最大条目数限制：插入后按 `created_at` 最旧优先淘汰

## 空结果快速重检（与常规命中分开）

常规缓存命中：

- TTL 内的缓存命中返回缓存条目，不做其他操作。

空结果快速重检：

- 这是**调用方侧**策略，使用 `ScanResult.cache_age_ms`
- 如果过滤/查询结果为空，且缓存扫描年龄至少达到 `empty_recheck_ms()`，调用方执行一次 `force_rescan(..., store=true)` 并重试
- 目的是减少当缓存仍在 TTL 内但文件已被添加时的陈旧否定结果

当前消费者：

- `glob`：当过滤匹配为空且扫描年龄超过阈值时重检
- `fuzzyFind`（`fd.rs`）：仅当查询非空且评分匹配为空时重检
- `grep`：当缓存目录候选文件列表为空时重检
- `astGrep`/`astEdit`（`ast.rs`）：当候选文件列表为空时重检

## 消费者默认值与缓存使用

`glob`/`fuzzyFind`/`grep` 的缓存是可选的（`cache?: boolean`，默认 `false`）。`astGrep`/`astEdit` 文件发现始终使用缓存（无可选标志）。

原生 API 中的当前默认值：

- `glob`：`hidden=false`，`gitignore=true`，`cache=false`；仅当 `includeNodeModules=true` 或模式提及 `node_modules` 时包含 `node_modules`；仅当 `sortByMtime=true` 时使用完整详细程度
- `fuzzyFind`：`hidden=false`，`gitignore=true`，`cache=false`，`node_modules` 被跳过，`follow_links=true`，最小详细程度
- `grep`：`hidden=true`，`gitignore=true`，`cache=false`；缓存目录模式在 glob 提及 `node_modules` 之前跳过 `node_modules`；最小详细程度
- `astGrep`/`astEdit`（文件发现）：`hidden=true`，`gitignore=true`，始终缓存；glob 提及 `node_modules` 之前跳过 `node_modules`；`follow_links=false`；最小详细程度

当前调用方：

- `@` 提及模糊文件自动完成启用缓存（`fuzzyFind` 使用 `cache: true`）：
  - `packages/tui/src/autocomplete.ts`
- 变更流通过 `packages/coding-agent/src/tools/fs-cache-invalidation.ts` 失效
- 工具级 grep 集成（`packages/coding-agent/src/tools/grep.ts`）当前调用原生 `grep` 时使用 `cache: false`

## 失效契约

原生失效入口点：

- `invalidateFsScanCache(path?: string)`
  - 带 `path`：移除 root 是目标路径前缀的缓存条目
  - 不带 path：清除所有扫描缓存条目

路径处理细节：

- 相对失效路径针对 cwd 解析
- 失效尝试规范化
- 如果目标不存在（例如删除后），回退规范化父目录并在可能时重新附加文件名
- 这保留了创建/删除/重命名的失效行为，其中一侧可能不存在

## Coding-agent 变更流责任

Coding-agent 代码必须在成功的文件系统变更后失效。

中央辅助：

- `invalidateFsScanAfterWrite(path)`
- `invalidateFsScanAfterDelete(path)`
- `invalidateFsScanAfterRename(oldPath, newPath)`（路径不同时失效两侧）

当前的变更调用点包括：

- `packages/coding-agent/src/tools/write.ts`
- `packages/coding-agent/src/edit/hashline/filesystem.ts`
- `packages/coding-agent/src/edit/modes/patch.ts`
- `packages/coding-agent/src/edit/modes/replace.ts`

规则：如果某个流变更文件系统内容或位置且绕过这些辅助，预计会出现缓存陈旧性 bug。

## 安全添加新缓存消费者

在为新扫描器/搜索路径引入缓存使用时：

1. **使用稳定的扫描策略输入**
   - 首先确定 hidden/gitignore/node_modules/detail 语义
   - 一致地将它们传入 `get_or_scan`/`force_rescan`，使缓存分区是有意的

2. **将缓存数据视为仅按遍历策略预过滤**
   - 检索后应用工具特定的过滤（glob 模式、类型过滤、评分）
   - 不要假设缓存条目已反映你的上层过滤器

3. **仅为陈旧否定风险实现空结果快速重检**
   - 使用 `scan.cache_age_ms >= empty_recheck_ms()`
   - 使用 `force_rescan(..., store=true, ...)` 重试一次
   - 将此路径与常规缓存命中逻辑分开

4. **显式尊重无缓存模式**
   - 当调用方禁用缓存时，调用 `force_rescan(..., store=false, ...)` 或使用非缓存流式遍历器
   - 不要在无缓存请求路径中填充共享缓存

5. **为任何新写入路径连接变更失效**
   - 在成功的 write/edit/delete/rename 后，调用 coding-agent 失效辅助
   - 对于 rename/move，失效新旧两个路径

6. **不要添加每次调用的 TTL 旋钮**
   - 当前契约仅为全局策略（环境配置），没有每请求 TTL 覆盖

## 已知边界

- 缓存范围是进程本地内存（`DashMap`），不会在进程重启间持久化。
- 缓存存储扫描条目，不是最终工具结果。
- `glob`/`fuzzyFind`/缓存 `grep`/`astGrep` 仅在键维度（`root`、`hidden`、`gitignore`、`skip_node_modules`、`detail`）匹配时共享扫描条目。
- `.git` 在扫描集合时始终排除，不受调用方选项影响。
