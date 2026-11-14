; installer-branding.nsh — MusePi 安装向导
;
; 架构：NSIS 负责"装什么"（解压、注册表、快捷方式），WebView2 宿主
; （MusePiInstallerHost.exe）负责"怎么问"（语言/路径/进度/完成）。
; 两者通过进程退出码与 %LOCALAPPDATA%\MusePi\Installer\answers.ini 通信。
;
; 为什么把 UI 交给宿主：客户端那套液态玻璃是 CSS 的 backdrop-filter，
; NSIS 原生控件无法表达（详见 docs/review/1.0-openbitfun-installer-absorption.md）。
;
; ── 关键时序约束 ──────────────────────────────────────────────────────
; 1. customInit 中的 WebView2 宿主只负责提问和写 answers.ini。宿主退出后，
;    NSIS 显示真实的文件释放进度与完成页；不再播放模拟进度或隐藏后台安装。
; 2. OTA 更新是 `--updated /S`（静默），必须完全跳过 UI。
; 3. 宿主 exe 及其 DLL 先解压到可写的 $PLUGINSDIR，再从那里运行。
;
; ── 注入时序 ──────────────────────────────────────────────────────────
; electron-builder 把本文件**前置**拼接在模板 installer.nsi 之前
; （NsisTarget.js computeFinalScript），所以顶层 !define 先于模板执行，
; 而 `customInit` / `customHeader` 等宏由模板按 !ifmacrodef 调用。

!include "${PROJECT_DIR}\release\ensure-shortcuts.nsh"

!define HOST_RELATIVE_PATH "installer-host"

!include "LogicLib.nsh"
!include "TextFunc.nsh"

!define MUSE_BG   "17151A"
!define MUSE_TEXT "EDEAE4"
!define MUI_BGCOLOR   "${MUSE_BG}"
!define MUI_TEXTCOLOR "${MUSE_TEXT}"
!define MUI_INSTFILESPAGE_COLORS "${MUSE_TEXT} ${MUSE_BG}"
!define MUI_INSTFILESPAGE_PROGRESSBAR colored

!ifndef BUILD_UNINSTALLER
; 路径已经由自绘宿主收集，原生目录页直接跳过；文件进度和完成页仍可见。
!define MUI_PAGE_CUSTOMFUNCTION_PRE MuseSkipNativeDirectory

!macro customInit
  ${IfNot} ${Silent}
    Call MuseRunInstallerHost
    ${If} $MuseHostExit != 0
    ${AndIf} $MuseHostExit != 2
      MessageBox MB_OK|MB_ICONSTOP "$(MUSEPI_HOST_FAILED)"
      Quit
    ${EndIf}
    ${IfNot} ${FileExists} "$MuseAnswersFile"
      Quit
    ${EndIf}
    Call MuseApplyHostAnswers
  ${EndIf}
!macroend

; ── 变量 ──────────────────────────────────────────────────────────────
Var MuseInstallPath
Var MuseLanguage
Var MuseDesktopShortcut
Var MuseStartMenu
Var MuseHostExit
Var MuseAnswersFile

; ──────────────────────────────────────────────────────────────────────
; 启动 WebView2 宿主
;
; 宿主及其 DLL 来自安装器的 extraResources；解压到 $PLUGINSDIR 后运行，
; 因为 WebView2 会在 exe 旁边建用户数据目录，$PLUGINSDIR 一定可写。
; ──────────────────────────────────────────────────────────────────────
Function MuseSkipNativeDirectory
  Abort
FunctionEnd

Function MuseRunInstallerHost
  StrCpy $MuseHostExit 0
  ; customInit 早于模板自己的插件目录初始化，提取宿主前必须显式创建。
  InitPluginsDir

  ; 宿主产物位于 apps/desktop/installer/dist（由
  ; scripts/build-installer-host.mjs 生成）。electron-builder 注入的
  ; BUILD_RESOURCES_DIR 指向 apps/desktop/build，所以用相对路径回溯。
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
; 约定：answers.ini 由宿主逐行写出 "key=value"，NSIS 只按第一个 '=' 拆分，
; 因而 Windows 路径中的其他等号不会破坏解析。
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
  ; Windows LCIDs are stable and available before MUI_LANGUAGE registers its
  ; compile-time LANG_* constants: English 1033, zh-CN 2052, zh-TW 1028.
  ${If} $MuseLanguage == "en-US"
    StrCpy $LANGUAGE 1033
  ${ElseIf} $MuseLanguage == "zh-CN"
    StrCpy $LANGUAGE 2052
  ${ElseIf} $MuseLanguage == "zh-TW"
    StrCpy $LANGUAGE 1028
  ${EndIf}
FunctionEnd

!endif

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
    LangString MUSEPI_UNWELCOME_TITLE ${LANG_SIMPCHINESE} "卸载 ${PRODUCT_NAME}"
    LangString MUSEPI_UNWELCOME_TEXT  ${LANG_SIMPCHINESE} "这将从本机移除 ${PRODUCT_NAME}。$\r$\n$\r$\n你的配置、会话记录与登录凭据会保留，重新安装后仍然可用。$\r$\n若想彻底清除，请在卸载后手动删除 ~\.musepi 目录。"
    LangString MUSEPI_HOST_FAILED ${LANG_SIMPCHINESE} "安装向导启动失败。请确认系统已安装 Microsoft Edge WebView2 运行时后重试。"
  !endif

  !ifdef LANG_TRADCHINESE
    LangString MUSEPI_UNWELCOME_TITLE ${LANG_TRADCHINESE} "解除安裝 ${PRODUCT_NAME}"
    LangString MUSEPI_UNWELCOME_TEXT  ${LANG_TRADCHINESE} "這會從本機移除 ${PRODUCT_NAME}。$\r$\n$\r$\n你的設定、工作階段記錄與登入憑證會保留，重新安裝後仍可使用。$\r$\n若要完全清除，請在解除安裝後手動刪除 ~\.musepi 目錄。"
    LangString MUSEPI_HOST_FAILED ${LANG_TRADCHINESE} "安裝精靈啟動失敗。請確認系統已安裝 Microsoft Edge WebView2 執行階段，然後重試。"
  !endif

  !ifdef LANG_ENGLISH
    LangString MUSEPI_UNWELCOME_TITLE ${LANG_ENGLISH} "Uninstall ${PRODUCT_NAME}"
    LangString MUSEPI_UNWELCOME_TEXT  ${LANG_ENGLISH} "This removes ${PRODUCT_NAME} from this computer.$\r$\n$\r$\nYour settings, sessions and credentials are kept and will still be there if you reinstall.$\r$\nTo remove everything, delete ~\.musepi after uninstalling."
    LangString MUSEPI_HOST_FAILED ${LANG_ENGLISH} "The setup wizard could not start. Verify that the Microsoft Edge WebView2 Runtime is installed, then retry."
  !endif
!macroend
