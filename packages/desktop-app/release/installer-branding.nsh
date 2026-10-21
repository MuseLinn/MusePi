; installer-branding.nsh — MusePi 安装向导
;
; 架构：NSIS 负责"装什么"（解压、注册表、快捷方式），WebView2 宿主
; （MusePiInstallerHost.exe）负责"怎么问"（语言/路径/进度/完成）。
; 两者通过进程退出码与 %LOCALAPPDATA%\MusePi\Installer\answers.json 通信。
;
; 为什么把 UI 交给宿主：客户端那套液态玻璃是 CSS 的 backdrop-filter，
; NSIS 原生控件无法表达（详见 docs/review/1.0-openbitfun-installer-absorption.md）。
;
; ── 关键时序约束 ──────────────────────────────────────────────────────
; 1. electron-builder 的 assisted 安装器**先解压**（installSection.nsh:66
;    installApplicationFiles），再调 customInstall。所以 UI 必须走
;    customWelcomePage，在解压之前跑完。
; 2. OTA 更新是 `--updated /S`（静默），必须完全跳过 UI，否则更新会卡在
;    一个没人点的窗口上。用 ${isUpdated} / ${Silent} 双重判断。
; 3. 宿主 exe 及其 DLL 必须在安装包里，解压到 $PLUGINSDIR 再运行——WebView2
;    会往 exe 旁边写用户数据，直接放 $INSTDIR（可能不可写）会启动失败。
;
; ── 注入时序 ──────────────────────────────────────────────────────────
; electron-builder 把本文件**前置**拼接在模板 installer.nsi 之前
; （NsisTarget.js computeFinalScript），所以顶层 !define 先于模板执行，
; 而 `customWelcomePage` / `customHeader` 等宏由模板按 !ifmacrodef 调用。

!include "${PROJECT_DIR}\release\ensure-shortcuts.nsh"

; ── 宿主安装包在安装器内的路径 ────────────────────────────────────────
; build-installer-host.mjs 把宿主与 UI 产出到 installer/dist/，
; electron-builder 通过 extraResources 把整个目录塞进安装器。
!define HOST_RELATIVE_PATH "installer-host"

; ── 测试骨架的自包含 ─────────────────────────────────────────────────
; 只依赖 NSIS 自带头文件：StrContains.nsh 属于 electron-builder 的模板目录，
; 不在标准 include 路径里，用它会让本文件无法独立编译（CI 编译门禁会红）。
;   LogicLib.nsh   ${If}/${Do} 等控制流
;   TextFunc.nsh   ${TrimNewLines}（FileFunc 里没有这个）
!include "LogicLib.nsh"
!include "TextFunc.nsh"

; ── 调色板（与客户端 tokens.css 同源）────────────────────────────────
!define MUSE_BG   "17151A"
!define MUSE_TEXT "EDEAE4"

!define MUI_BGCOLOR   "${MUSE_BG}"
!define MUI_TEXTCOLOR "${MUSE_TEXT}"
!define MUI_INSTFILESPAGE_COLORS "${MUSE_TEXT} ${MUSE_BG}"
!define MUI_INSTFILESPAGE_PROGRESSBAR colored

; ── 变量 ──────────────────────────────────────────────────────────────
Var MuseInstallPath
Var MuseLanguage
Var MuseDesktopShortcut
Var MuseStartMenu
Var MuseHostExit
Var MuseAnswersFile

; ──────────────────────────────────────────────────────────────────────
; 品牌欢迎页 → 实际是 WebView2 宿主的宿主页
;
; 这个页面本身不显示 NSIS 控件；它在 SHOW 回调里启动宿主并在宿主退出后
; 用 Abort 跳过自己，把控制权交给"安装位置"页（宿主已问过路径了，
; 这里直接用宿主给出的答案继续）。
;
; 之所以仍然占用一个 MUI 页面：NSIS 需要一个页面来承载同步的 UI 阻塞，
; 且可以复用 MUI 的向导外壳（背景、按钮栏）。
; ──────────────────────────────────────────────────────────────────────
!macro customWelcomePage
  ; 静默更新：本页 SHOW 回调里会 Abort，等同 electron-builder 的
  ; skipPageIfUpdated（那个宏属于模板，独立编译时不存在，所以不用它）。
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW MuseInstallerHostShow
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE MuseInstallerHostLeave
  !define MUI_WELCOMEPAGE_TITLE "$(MUSEPI_WELCOME_TITLE)"
  !define MUI_WELCOMEPAGE_TEXT "$(MUSEPI_WELCOME_TEXT)"
  !insertmacro MUI_PAGE_WELCOME
!macroend

; 欢迎页显示时启动宿主（阻塞等待其退出）
Function MuseInstallerHostShow
  ; 静默路径必须完全跳过 UI：OTA 用 `--updated /S` 拉起安装器，此时没有人
  ; 点击窗口，弹出向导会让更新永久挂住。`${Silent}` 覆盖 /S 与 --updated /S
  ; 两种情形（installSection.nsh:5,94 也是这么判断的）。
  ${If} ${Silent}
    Abort
  ${EndIf}

  Call MuseRunInstallerHost

  ; 宿主自己问完了所有问题，跳过后续 NSIS 的目录页
  Call MuseApplyHostAnswers
FunctionEnd

; 离开欢迎页时（用户在上面点了"取消"或宿主直接退出）
Function MuseInstallerHostLeave
  ${If} $MuseHostExit != 0
  ${AndIf} $MuseHostExit != 2
    ; 2 = 宿主被关闭（用户取消）；其余非 0 视为失败
    MessageBox MB_OK|MB_ICONSTOP "$(MUSEPI_HOST_FAILED)"
    Abort
  ${EndIf}
FunctionEnd

; ──────────────────────────────────────────────────────────────────────
; 启动 WebView2 宿主
;
; 宿主及其 DLL 来自安装器的 extraResources；解压到 $PLUGINSDIR 后运行，
; 因为 WebView2 会在 exe 旁边建用户数据目录，$PLUGINSDIR 一定可写。
; ──────────────────────────────────────────────────────────────────────
Function MuseRunInstallerHost
  StrCpy $MuseHostExit 0

  ; 宿主产物位于 packages/desktop-app/installer/dist（由
  ; scripts/build-installer-host.mjs 生成）。electron-builder 注入的
  ; BUILD_RESOURCES_DIR 指向 packages/desktop-app/build，所以用相对路径回溯。
  ; 编译期就校验存在性：缺产物必须让打包失败，而不是产出一个没有 UI 的安装器。
  !if /FileExists "${BUILD_RESOURCES_DIR}\..\installer\dist\MusePiInstallerHost.exe"
  !else
    !error "installer host missing: run `bun scripts/build-installer-host.mjs` before packaging"
  !endif

  SetOutPath "$PLUGINSDIR\${HOST_RELATIVE_PATH}"
  ; /x 排除 WebView2 的运行期用户数据目录：它是宿主跑过一次之后才会出现的
  ; 浏览器缓存（含被锁定的 CrashpadMetrics*.pma），既不该进安装包，也会让
  ; File 在文件被占用时直接失败。构建脚本已先行清理，这里是第二道保险。
  File /r /x "*.WebView2" /x "EBWebView" "${BUILD_RESOURCES_DIR}\..\installer\dist\*.*"

  StrCpy $MuseAnswersFile "$LOCALAPPDATA\MusePi\Installer\answers.ini"

  ; 每次安装都是干净的提问，避免读到上一次的答案
  Delete "$MuseAnswersFile"

  nsExec::ExecToStack '"$PLUGINSDIR\${HOST_RELATIVE_PATH}\MusePiInstallerHost.exe" --ui "$PLUGINSDIR\${HOST_RELATIVE_PATH}\ui\index.html" --install-root "$INSTDIR"'
  Pop $MuseHostExit
  Pop $0
FunctionEnd

; ──────────────────────────────────────────────────────────────────────
; 把宿主的答案落到 NSIS 变量
;
; 约定：answers.json 由宿主写出，形如
;   {"path":"C:\\...","language":"zh-CN","desktopShortcut":true,"startMenu":true}
; 解析用 NSIS 的 FileOpen/FileRead 逐字符扫描过于笨重，这里改成宿主写一个
; 逐行 "key=value" 的辅助文件，NSIS 只做行解析——简单、无歧义。
; ──────────────────────────────────────────────────────────────────────
Function MuseApplyHostAnswers
  ; 答案文件位置。若调用方已经设过 $MuseAnswersFile（测试或自定义部署），
  ; 就尊重它；否则用标准位置。
  ${If} $MuseAnswersFile == ""
    StrCpy $MuseAnswersFile "$LOCALAPPDATA\MusePi\Installer\answers.ini"
  ${EndIf}

  ${IfNot} ${FileExists} "$MuseAnswersFile"
    ; 没拿到答案（用户取消）：保留默认值
    Return
  ${EndIf}

  FileOpen $0 "$MuseAnswersFile" r
  ${If} $0 == ""
    Return
  ${EndIf}

  ${Do}
    FileRead $0 $1
    ${If} $1 == ""
      ${ExitDo}
    ${EndIf}
    ${TrimNewLines} $1 $1
    ${If} $1 == ""
      ${Continue}
    ${EndIf}

    ; 手写 key=value 拆分：不依赖 StrContains.nsh 的 ${StrLoc}
    ; （那属于 electron-builder 模板目录，独立编译时找不到）。
    ; 值里允许出现 '='，只按**第一个** '=' 切分。
    StrCpy $3 ""
    StrCpy $4 ""
    StrCpy $2 0
    ${Do}
      StrCpy $5 $1 1 $2
      ${If} $5 == ""
        ${ExitDo}
      ${EndIf}
      ${If} $5 == "="
        IntOp $2 $2 + 1
        StrCpy $4 $1 "" $2
        ${ExitDo}
      ${EndIf}
      StrCpy $3 "$3$5"
      IntOp $2 $2 + 1
    ${Loop}

    ${If} $3 == "path"
      StrCpy $MuseInstallPath $4
    ${ElseIf} $3 == "language"
      StrCpy $MuseLanguage $4
    ${ElseIf} $3 == "desktopShortcut"
      StrCpy $MuseDesktopShortcut $4
    ${ElseIf} $3 == "startMenu"
      StrCpy $MuseStartMenu $4
    ${EndIf}
  ${Loop}

  FileClose $0
  Delete "$MuseAnswersFile"

  ${If} $MuseInstallPath != ""
    StrCpy $INSTDIR $MuseInstallPath
  ${EndIf}
FunctionEnd

; ──────────────────────────────────────────────────────────────────────
; 快捷方式：ensure-shortcuts.nsh 已经定义了 customInstall 并**无条件**重建
; 桌面与开始菜单快捷方式（为修 OTA 后图标丢失，见其文件头注释）。
;
; 这里不再定义第二个 customInstall —— NSIS 不允许重定义宏。用户的"要不要
; 桌面图标"选择改在宿主侧生效：宿主根据选项决定是否真的向导 —— 即
; answers.ini 里的 desktopShortcut/startMenu 只用于真实安装完成后的一次性
; 清理，见 MusePruneShortcuts（在 installSection 之后通过 customInstall
; 的调用顺序无法插入，所以改由 install 完成后由 NSIS 主流程统一处理）。
;
; 简化决定：**不删快捷方式**。electron-builder 的 createDesktopShortcut
; ("always") 与 createStartMenuShortcut 已经按配置建好；用户在宿主的勾选
; 只影响 answers.ini，而为了一个勾选框引入"先建再删"的逻辑不值得——
; 装了应用却少一个图标，比多一个图标更让人困惑。宿主 UI 上的两个勾选框
; 因此标记为"即将生效"，后续版本再接。

; ── 卸载向导 ──────────────────────────────────────────────────────────
!macro customUnWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "$(MUSEPI_UNWELCOME_TITLE)"
  !define MUI_WELCOMEPAGE_TEXT  "$(MUSEPI_UNWELCOME_TEXT)"
  !insertmacro MUI_UNPAGE_WELCOME
!macroend

; ── 语言表 ────────────────────────────────────────────────────────────
; customHeader 位于模板 `!insertmacro addLangs` 之后，MUI_LANGUAGE 已注册，
; 此时才能定义 LangString。
!macro customHeader
  !ifdef LANG_SIMPCHINESE
    LangString MUSEPI_WELCOME_TITLE ${LANG_SIMPCHINESE} "正在准备安装"
    LangString MUSEPI_WELCOME_TEXT  ${LANG_SIMPCHINESE} "安装向导即将打开。"
    LangString MUSEPI_UNWELCOME_TITLE ${LANG_SIMPCHINESE} "卸载 ${PRODUCT_NAME}"
    LangString MUSEPI_UNWELCOME_TEXT  ${LANG_SIMPCHINESE} "这将从本机移除 ${PRODUCT_NAME}。$\r$\n$\r$\n你的配置、会话记录与登录凭据会保留，重新安装后仍然可用。$\r$\n若想彻底清除，请在卸载后手动删除 ~\.musepi 目录。"
    LangString MUSEPI_HOST_FAILED ${LANG_SIMPCHINESE} "安装向导启动失败。请确认系统已安装 Microsoft Edge WebView2 运行时后重试。"
  !endif

  !ifdef LANG_ENGLISH
    LangString MUSEPI_WELCOME_TITLE ${LANG_ENGLISH} "Preparing to install"
    LangString MUSEPI_WELCOME_TEXT  ${LANG_ENGLISH} "The setup wizard is about to open."
    LangString MUSEPI_UNWELCOME_TITLE ${LANG_ENGLISH} "Uninstall ${PRODUCT_NAME}"
    LangString MUSEPI_UNWELCOME_TEXT  ${LANG_ENGLISH} "This removes ${PRODUCT_NAME} from this computer.$\r$\n$\r$\nYour settings, sessions and credentials are kept and will still be there if you reinstall.$\r$\nTo remove everything, delete ~\.musepi after uninstalling."
    LangString MUSEPI_HOST_FAILED ${LANG_ENGLISH} "The setup wizard could not start. Verify that the Microsoft Edge WebView2 Runtime is installed, then retry."
  !endif
!macroend
