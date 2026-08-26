# MusePi Assembly — 声明式装配与启动验证

[English](assembly.md) | 中文

`musepi.assembly.toml` 是 musepi 的产品装配清单，声明：
- **面**（TUI / daemon / headless）——控制扩展加载的范围
- **managed 扩展**——声明后的扩展加载失败会 **fail-loud**（默认），避免静默回退
- **seams**——可显式选择的可换核心实现（terminal provider、compaction 方法）

## 文件位置与发现顺序

项目级 > 全局级（前者 per-key 胜出）：

1. `<cwd>/.musepi/assembly.toml`（从 cwd 向上查找）
2. `$MUSEPI_AGENT_DIR/assembly.toml`（当前 profile 的 agent 目录）
3. `~/.musepi/assembly.toml`（用户全局）

## 格式

```toml
[assembly]
# surface = "tui" | "daemon" | "headless" | "acp"   # 缺省 auto（按 mode）
degraded_ok = false                                  # 扩展加载失败语义

[extensions]
# include = ["my-extension", "another-ext"]          # 白名单
# exclude = ["*debug*", "*legacy*"]                  # 排除 glob
# patterns = ["**/tools/**", "extensions/skills"]    # 路径过滤

[seams.terminal]
provider = "auto"        # "auto" | "bun-pty" | "node-pty"

[seams.compaction]
method = "snapcompact"   # 首选 compaction 方法
```

## 行为

### 启动验证
- **无 manifest** → 保持现有行为（所有错误 warn，session 继续）
- **有 manifest** → managed 扩展的加载错误 **throw**（除非 `degraded_ok = true`）
- unmanaged 扩展错误仍 warn，通过 `musepi assembly status` 可见

### 面裁剪
- `musepi assembly verify` 会读取当前 cwd 的 manifest 并打印过滤后扩展数
- manifest 中 `extensions.patterns` 控制扩展加载 glob

### Seam 选择
- `terminal.provider` 控制 daemon terminal 后端：`auto`（默认）= bun-pty 失败时回退 node-pty；显式值 = 失败时报错
- `compaction.method` 仅为 manifest 侧的校验——实际 compaction 由 `settings.compaction.methodOrder` 控制

## CLI 命令

```bash
musepi assembly status      # 显示当前 manifest、surface、boot 状态
musepi assembly verify      # 静态验证 manifest + 扩展路径过滤结果
```

## 设计原则

1. **渐进启用**：无 manifest 时老行为不变，老用户升级无感
2. **fail-loud on declared**：声明过托管的扩展失败就报错，未声明的继续 soft-fail
3. **可见性**：所有失败通过 `musepi assembly status` 可见，不静默
4. **配置驱动**：manifest 是唯一配置源，settings 只读不写（terminal.provider 可通过 settings 显式覆盖）
