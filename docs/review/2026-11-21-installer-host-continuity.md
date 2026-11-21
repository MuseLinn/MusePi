# 安装过程保持自制界面：宿主驱动静默安装（2026-11-21）

用户报告：安装过程中突然出现原生 NSIS 页面（「正在安装」+绿色进度条+上一步/下一步/取消），与自制 WebView2 安装器的液态玻璃界面断裂。

## 结论

安装全程只有一块可见界面：`MusePiInstallerHost.exe` 的 WebView2 窗口。宿主收集语言/路径/快捷方式后**不退出**，安装器随后把**自己**切成静默模式（`SetSilent silent`），在后台执行解压、注册表与快捷方式；宿主轮询安装器发布的阶段与磁盘上真实写入的字节数，最后在自己的完成页收尾。原生目录页/进度页/完成页一个都不创建。

OTA 更新（`--updated /S`）不经过宿主，行为与之前完全一致。

## 为什么不是"宿主再拉起一个静默安装器"

最直观的做法是宿主写答案后执行 `setup.exe /S`。不可行：electron-builder 的 assisted 安装器在 `.onInit` 里插入 `ALLOW_ONLY_ONE_INSTALLER_INSTANCE`（`${APP_GUID}` 命名互斥体）。外层安装器正在等宿主时持有它，子进程会走到 `Abort`，静默安装根本不会开始。

所以静默切换必须发生在**同一个安装器进程**里：`customInit` 是模板在页面创建之前调用 `.onInit` 的位置，`SetSilent silent` 在这里生效后，MUI 不再创建任何页面（本机探针已验证：只有 Section 执行，进程直接以 0 退出，没有窗口）。

## 时序

```
bootstrap (InstallerBootstrap.cs)
  └─ 解包 payload → 以私有 TEMP + MUSEPI_ANSWERS_DIR 启动 NSIS
       └─ .onInit / customInit（页面之前）
            HideWindow                        ← 安装器窗口从一开始就不可见
            解包宿主到 $PLUGINSDIR\installer-host
            Exec 宿主（不等待）
            ┌─ 宿主：语言 → 位置 → 校验（只检查目标目录里的 MusePi 进程）
            │        写 answers.ini（临时文件 + 重命名，原子出现）
            │        继续存活，显示"正在启动安装…"
            └─ NSIS 轮询 answers.ini（150ms，无超时：用户可能停在向导上）
            应用 path/language → phase=installing → SetSilent silent
       └─ Section "install"：解压 → 注册表 → 快捷方式（全程无窗口）
            customInstall 末尾：phase=done → 等宿主关闭完成页
       └─ 宿主看到 phase=done → 完成页 → 用户点完成 → 宿主退出 0
       └─ NSIS 探针发现宿主退出 → 安装器退出 0
```

## 通道契约

状态目录由 `MUSEPI_ANSWERS_DIR` 决定（bootstrap 设成本次运行的私有目录，退出时整目录删除）；未设置时回落到 `%LOCALAPPDATA%\MusePi\Installer`。

| 文件 | 方向 | 内容 |
| --- | --- | --- |
| `answers.ini` | 宿主 → 安装器 | `path=` / `language=` / `desktopShortcut=` / `startMenu=`，每行一条，只按第一个 `=` 拆分 |
| `install-status.ini` | 安装器 → 宿主 | `phase=installing` / `phase=done` |
| `host-status.ini` | 宿主 → 启动器 | `exit=0` / `2` / `3` |

存活信号用两个命名互斥体，而不是进程名匹配（同名进程可能来自别的安装路径）：

- `Local\MusePi.Installer.Setup`：安装器在 `customInit` 创建并持有到进程退出；宿主用它判断安装器是否提前死掉。
- `Local\MusePi.Installer.Host`：宿主在启动时创建；安装器在 `customInstall` 用它判断完成页是否已关闭。

双方都用 `OpenMutex` + `CloseHandle` 探测（拿不到句柄即对方已退出），句柄不泄漏；宿主另用 `--installer-pid` 仅做取消时的 `TerminateProcess`，不用来判活（PID 会被复用）。

两条防呆规则（都是实机跑出来的）：

- **启动宽限期**：安装器在 `Exec` 之后立刻开始轮询，而宿主创建互斥体需要一点时间。只有在"见过宿主"之后，"探针看不到宿主"才判定为退出；从没出现过则给 20 秒再报错。否则一次正常的慢启动会被误判成宿主崩溃。
- **孤儿宿主**：宿主在提问阶段也盯着安装器 PID。安装器自己退出（例如缺 WebView2、另一个实例抢锁）时宿主随之关闭，不会留下来继续持有互斥体。否则下一次安装会永远以为"宿主还活着"，永远不退出。
- `MuseHostAlive` 读的是 `$1`：System 插件的 `.r1` 写的是用户变量 `$1`，不是寄存器 `$R1`。读 `$R1` 会拿到 NSIS 内部的残留非零值，探针永远为真——这个错误会表现为"点击完成后安装器永不退出"，静态门禁里专门有一条断言盯着它。

`answers.ini` 仍然是一次性的：安装器应用后立即删除，与旧契约一致。`--install-root`、`--shortcut-name`、`--app-exe` 由 NSIS 显式传给宿主，双方不再各自猜路径。

## 进度语义

静默 NSIS 不提供任何进度回调：`File /r` 是一个整体操作，模板里没有可在文件之间插入的钩子。因此宿主只显示两件真实的事：

1. **阶段**：安装器发布 `installing` 之前显示"正在检查安装环境…"，之后显示"正在写入应用文件…"；取消时显示"正在取消安装…"。
2. **已写入字节数**：约每秒遍历一次目标目录累加文件大小，显示"已写入 N KB/MB"。它可能短暂倒退（旧版本卸载会删文件），这是事实，不做平滑伪装。

进度条改为不确定态（`aria-busy="true"`，移动光带），没有任何百分比。宿主 smoke 测试新增两条断言：`#bar` 必须是 busy、页面里不能再出现 `#progress-percent`——百分比回来了就会红。

## 取消、失败与回滚

**取消**：进度页有"取消安装"按钮，先展开行内确认（不弹原生对话框）。按钮在安装器接受答案之前不可用——那时还没有写入任何东西，而且宿主也只有到 `awaiting` 才知道这是不是升级。确认后宿主用 `TerminateProcess(installerPid, 2)` 结束安装器——NSIS 的文件段没有可中断点，发信号或假装"已停止"都是撒谎。随后：

- 新装（目标目录本次之前不存在或为空）：删除目标目录、删除本次运行期间创建的桌面/开始菜单快捷方式（`ShouldRemoveShortcut`：只有目标 exe 已不在且链接写入时间不早于本次开始时才删）、删除本次写入的卸载注册：**添加/删除程序条目按 `UninstallString`/`QuietUninstallString` 的 `"<target>\` 前缀识别**（electron-builder 不给这个键写 `InstallLocation`，只有内部状态键 `HKCU\Software\{APP_GUID}` 有，所以两种匹配都要做），以及该内部状态键本身。
- 升级（目标目录已有文件）：**什么都不删**。目录、快捷方式与注册项都属于上一个版本：删掉目录会连带毁掉用户原本能用的版本；删掉 `InstallLocation` 会让下一次安装回落到默认目录、在旧副本之外再装一份，反而修不好。界面用自己的文案说明"升级未完成，重新运行安装程序即可修复"。

**失败**：宿主每 180ms 检查安装器进程（`Local\MusePi.Installer.Setup` 互斥体）。安装器在写出 `phase=done` 之前消失，就按失败处理，回滚规则同上；界面区分新装/升级两种情况。

**退出码**：

| 码 | 含义 |
| --- | --- |
| 0 | 安装完成（不论是否勾选立即启动） |
| 2 | 用户取消（装前关闭窗口，或安装中取消并回滚） |
| 3 | 安装失败（WebView2 初始化失败、宿主启动失败、安装器提前退出且未写 `phase=done`） |

宿主在**进入终态的那一刻**写 `host-status.ini`（`Succeed`/`FailInstall`/`CancelInstall`，在展示结果页之前），所以取消终止安装器之后启动器仍能拿到 2/3；`InitialiseAsync` 失败（WebView2 不可用）先置 3 再报错关闭，不会再被当成"用户取消"。

`InstallerBootstrap.cs` 的归一顺序：有回执 → 用回执；无回执且交互安装 → 轮询 3 秒；仍无回执时，`install-status.ini` 有 `phase=done` 记 0，否则记 3。OTA 的 `/S` 路径不写状态文件、不启动宿主，直接沿用 NSIS 子进程退出码。

## 对既有契约的影响

- **answers.ini**：位置、格式、一次性消费不变；路径改为由 NSIS 显式传入，`MUSEPI_ANSWERS_DIR` 仍然生效。
- **安装位置 / 语言**：`$INSTDIR` 与 `$LANGUAGE` 仍在 `customInit` 里由答案设置，静默段沿用同一组值。
- **快捷方式 / 卸载注册项**：仍由 electron-builder 模板与 `ensure-shortcuts.nsh` 写入，未改动；只在取消回滚时按事实清理。
- **静默安装**：这次的"静默段"就是同一个进程里的 `SetSilent silent`，它读答案、跳过原生目录页，与 OTA 的 `/S` 共享同一条无 UI 路径。
- **客户端运行检查**：从"任何位置的 MusePi 都在拦"收紧为"只有从目标目录运行的 MusePi 才拦"，与 `customCheckAppRunning` 的路径判定一致；否则并行安装与预览 harness 永远无法开始。

## 验证

0. **宿主自检**（`MusePiInstallerHost.exe --self-test`）：退出码契约、阶段解析，以及回滚谓词矩阵——`UninstallPointsInto`（带引号/裸路径/大小写/相邻目录 `MusePi2`/空值）与 `ShouldRemoveShortcut`（本次创建删、旧链接留、可用安装留），再真实创建一条指向临时目录的一次性卸载键，断言 `RemoveUninstallEntries` 只删它、不碰无关键。
1. **宿主 smoke**（`node apps/desktop/scripts/build-installer-host.mjs --smoke`）：WebView2 绑定、玻璃层、`#bar` 为 busy、无百分比、页面数 5、无横向滚动。PASS。
2. **NSIS 编译门禁**（`python apps/desktop/scripts/check-installer-branding.py`）：位图、无 BOM、`build.nsis.include` 接线，外加静态契约——
   - `customInit` 内顺序必须是"等答案 → 应用答案 → SetSilent"，`HideWindow` 存在；
   - 宿主命令行带 `--answers/--status/--installer-pid`，两个互斥体名字与宿主一致；
   - `customInstall` 写 `phase=done` 并等待宿主；
   - 进度页不确定态、无百分比，宿主状态 `installed/cancelled/failed` 都有渲染分支；
   - **回滚策略**：卸载条目按 `UninstallString` 匹配、升级在 `Rollback` 开头直接返回、快捷方式有可测谓词、三语都有升级取消文案、预览与截图脚本具备失败/取消证据路径；
   - 预览 harness 与截图脚本存在且带窗口断言（真实模板 `.onInit` 调用 `customInit` 的检查在装了 `node_modules` 的环境执行，本 worktree 未安装时打印跳过说明）。
3. **本机实跑**（`pwsh -File apps/desktop/scripts/capture-installer-pages.ps1`）：用 `installer/preview/installer-preview.nsi` 编译出的预览走同一条生产时序。断言安装器进程在整个交互安装期间**没有任何可见窗口**（每 100–150ms 采样一次），宿主产出 4 张 WebView2 页面截图（语言/位置/进度/完成），点击完成后的进程退出码为 0；静默 `/S` 运行全程无窗口、退出 0、不写答案。本机（Windows 11 / 175% DPI）实测：

   | 断言 | 结果 |
   | --- | --- |
   | 语言页/位置页/进度页期间安装器可见窗口 | 0 |
   | 全程可见窗口采样总数 | 0 |
   | `phase=installing` → `phase=done` | 均出现 |
   | 进度页显示 | `正在写入应用文件…` + `已写入 190 KB`（无百分比） |
   | 交互安装退出码 | 0 |
   | `/S` 静默安装 | 无窗口、退出 0、不写 `answers.ini` |
   | 取消安装 | 退出 2、目标目录已删、一次性卸载条目已删、宿主写了回执、`5-cancelled.png` |
   | `customInstall` 前失败 | 退出 3、目标目录已删、一次性卸载条目已删、`6-failed.png` |

   截图与日志：`.tmp/installer-shots/`（`1-language.png` … `4-finish.png`、`capture.log`）。预览截图由宿主的 `CoreWebView2.CapturePreviewAsync` 产出——外部进程对 GPU 合成的 WebView2 做屏幕抓取会得到全黑图，页面像素才是有效证据。

## 已知限制

- **升级无法真正回滚**：没有暂存目录，旧版本可能已被卸载器删除。界面如实说明并提示重新运行安装程序，不宣称"已恢复"。
- **取消依赖终止进程**：NSIS 文件段无法从外部安全中断；被终止的安装器不会执行自身清理，可能在自己的 `%TEMP%\ns*.tmp` 里留下解包残留（不影响目标目录与系统状态）。
- **启动器的私有目录**：成功路径下宿主的窗口先关闭，启动器随即删除目录；取消/失败时宿主仍在显示结果页，启动器会等它退出（最多 10 分钟）再删，期间目录保留。
- **进度是"阶段 + 已写入字节"**，不是百分比；目录遍历每秒一次，极慢的磁盘上刷新频率会自然降低。
- **预览的安装段是 Sleep 出来的占位写入**，只验证时序与界面，不验证 200MB 真实载荷的耗时。