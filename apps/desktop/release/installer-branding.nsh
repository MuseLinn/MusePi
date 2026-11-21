; installer-branding.nsh — MusePi 安装向导
;
; 架构：安装全程只有一块可见界面 —— 本脚本启动的 WebView2 宿主
; （MusePiInstallerHost.exe）。NSIS 负责"装什么"（解压、注册表、快捷方式），
; 并在宿主确认选项后把自己切成静默模式，因此原生目录页/进度页/完成页
; 一个都不会创建。
;
; 为什么把 UI 交给宿主：客户端那套液态玻璃是 CSS 的 backdrop-filter，
; NSIS 原生控件无法表达（详见 docs/review/1.0-openbitfun-installer-absorption.md
; 与 docs/review/2026-11-21-installer-host-continuity.md）。
;
; ── 关键时序 ──────────────────────────────────────────────────────────
; 1. customInit 在页面前、`.onInit` 里运行。宿主用 Exec 异步启动（不等它
;    退出）：它收集语言/路径/快捷方式，校验环境，原子写出 answers.ini，
;    然后留在原地继续显示进度。
; 2. customInit 轮询 answers.ini。拿到答案后写入 $INSTDIR/$LANGUAGE，
;    在状态文件写 phase=installing，再 SetSilent silent。静默标志在页面
;    创建之前生效，所以安装段运行时没有任何原生窗口。
; 3. 安装段（解压/注册表/快捷方式）跑完后，customInstall 末尾写
;    phase=done 并等宿主关闭；宿主退出后安装器以 0 退出。
; 4. 取消由宿主终止本进程（TerminateProcess，退出码 2）并回滚；安装器
;    异常退出时宿主通过存活探针发现，回滚后以 3 退出。
; 5. OTA 更新是 `--updated /S`（${Silent}），完全跳过宿主与状态文件。
;
; ── 与宿主的两条通道 ──────────────────────────────────────────────────
; 文件（位置由 MUSEPI_ANSWERS_DIR 覆盖，InstallerBootstrap.cs 把它设成本次
; 运行的私有目录；否则用 %LOCALAPPDATA%\MusePi\Installer）：
;   answers.ini        宿主 → 安装器：path/language/desktopShortcut/startMenu
;   install-status.ini 安装器 → 宿主：phase=installing|done
;   host-status.ini    宿主 → 启动器：exit=0|2|3
; 命名互斥体（OpenMutex 存在性探针，比按进程名匹配可靠）：
;   MUSE_SETUP_MUTEX 由安装器持有，宿主据此判断安装器是否还活着；
;   MUSE_HOST_MUTEX  由宿主持有，安装器据此判断完成页是否已关闭。
;
; ── 注入时序 ──────────────────────────────────────────────────────────
; electron-builder 把本文件**前置**拼接在模板 installer.nsi 之前
; （NsisTarget.js computeFinalScript），所以顶层 !define 先于模板执行，
; 而 `customInit` / `customHeader` 等宏由模板按 !ifmacrodef 调用。

!include "${PROJECT_DIR}\release\ensure-shortcuts.nsh"

!define HOST_RELATIVE_PATH "installer-host"

; ── 通道常量 ──────────────────────────────────────────────────────────
; 独立编译（编译门禁、预览）没有 electron-builder 注入的 SHORTCUT_NAME。
!ifndef SHORTCUT_NAME
  !define SHORTCUT_NAME "${PRODUCT_NAME}"
!endif

!define MUSE_STATUS_FILE_NAME      "install-status.ini"
!define MUSE_HOST_STATUS_FILE_NAME "host-status.ini"
!define MUSE_SETUP_MUTEX "Local\MusePi.Installer.Setup"
!define MUSE_HOST_MUTEX  "Local\MusePi.Installer.Host"

!include "LogicLib.nsh"
!include "TextFunc.nsh"

; ── 调色板（与客户端 tokens.css 同源）────────────────────────────────
!define MUSE_BG   "17151A"
!define MUSE_TEXT "EDEAE4"

!define MUI_BGCOLOR   "${MUSE_BG}"
!define MUI_TEXTCOLOR "${MUSE_TEXT}"
!define MUI_INSTFILESPAGE_COLORS "${MUSE_TEXT} ${MUSE_BG}"
!define MUI_INSTFILESPAGE_PROGRESSBAR colored

; 卸载器构建不包含安装路径；未引用的变量与函数会被 /WX 判死。
!ifndef BUILD_UNINSTALLER
; 兜底：若宿主始终没接管（例如旧版本安装包残留），原生目录页也不会出现。
!define MUI_PAGE_CUSTOMFUNCTION_PRE MuseSkipNativeDirectory

!macro customInit
  ${IfNot} ${Silent}
    ; 安装器的窗口在任何原生页面出现之前就隐藏：普通安装自始至终只有宿主
    ; 一块界面，连一闪而过的空白向导窗口也不该出现。
    HideWindow
    Call MusePrepareHostChannel
    Call MuseStartInstallerHost
    Call MuseWaitForHostDecision

    ${If} $MuseHostDecision == "install"
      Call MuseApplyHostAnswers
      StrCpy $MuseDriven "1"
      StrCpy $MusePhase "installing"
      Call MusePublishPhase
      ; 在页面创建之前切静默：原生进度页/完成页从此不存在。
      SetSilent silent
    ${ElseIf} $MuseHostDecision == "cancel"
      SetErrorLevel 2
      Quit
    ${Else}
      MessageBox MB_OK|MB_ICONSTOP "$(MUSEPI_HOST_FAILED)"
      SetErrorLevel 3
      Quit
    ${EndIf}
  ${EndIf}
!macroend

; ── 变量 ──────────────────────────────────────────────────────────────
Var MuseInstallPath
Var MuseLanguage
Var MuseDesktopShortcut
Var MuseStartMenu
Var MuseAnswersFile
Var MuseStatusFile
Var MuseHostStatusFile
Var MuseStateDir
Var MuseDriven
Var MuseInstallerPid
Var MuseHostDecision
Var MuseHostSeen
Var MusePhase
Var MuseProbeAlive
Var MuseWaitTicks

Function MuseSkipNativeDirectory
  Abort
FunctionEnd

; ──────────────────────────────────────────────────────────────────────
; 状态目录与通道初始化
;
; MUSEPI_ANSWERS_DIR 由 InstallerBootstrap.cs 指向本次运行的私有目录：
; 代码取消/失败不会在用户的 %LOCALAPPDATA% 里留下上一次的答案或状态。
; ──────────────────────────────────────────────────────────────────────
Function MusePrepareHostChannel
  StrCpy $MuseDriven "0"
  StrCpy $MuseHostDecision ""

  ; customInit 早于模板自己的插件目录初始化，提取宿主前必须显式创建。
  InitPluginsDir

  ReadEnvStr $0 "MUSEPI_ANSWERS_DIR"
  ${If} $0 == ""
    StrCpy $MuseStateDir "$LOCALAPPDATA\MusePi\Installer"
  ${Else}
    StrCpy $MuseStateDir $0
  ${EndIf}
  CreateDirectory "$MuseStateDir"

  StrCpy $MuseAnswersFile "$MuseStateDir\answers.ini"
  StrCpy $MuseStatusFile "$MuseStateDir\${MUSE_STATUS_FILE_NAME}"
  StrCpy $MuseHostStatusFile "$MuseStateDir\${MUSE_HOST_STATUS_FILE_NAME}"
  Delete "$MuseAnswersFile"
  Delete "$MuseStatusFile"
  Delete "$MuseHostStatusFile"

  ; 安装器存活信号：句柄故意不关闭，随本进程退出由系统回收。
  ; ?e 会把 GetLastError 压栈，必须弹掉，否则后面的 Pop 会读到它。
  System::Call 'kernel32::CreateMutex(p 0, i 0, t "${MUSE_SETUP_MUTEX}") p .r1 ?e'
  Pop $0

  ; 取消时宿主需要能终止本进程，因此要给它 PID。
  System::Call 'kernel32::GetCurrentProcessId() i .r0'
  StrCpy $MuseInstallerPid $0
FunctionEnd

; ──────────────────────────────────────────────────────────────────────
; 启动 WebView2 宿主（不等待）
;
; 宿主及其 DLL 来自安装器的 extraResources；解压到 $PLUGINSDIR 后运行，
; 因为 WebView2 会在 exe 旁边建用户数据目录，$PLUGINSDIR 一定可写。
; ──────────────────────────────────────────────────────────────────────
Function MuseStartInstallerHost
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

  ClearErrors
  ; 每个路径都加引号：用户名带空格时 %LOCALAPPDATA% 也一样带空格。
  Exec '"$PLUGINSDIR\${HOST_RELATIVE_PATH}\MusePiInstallerHost.exe" --ui "$PLUGINSDIR\${HOST_RELATIVE_PATH}\ui\index.html" --install-root "$INSTDIR" --answers "$MuseAnswersFile" --status "$MuseStatusFile" --host-status "$MuseHostStatusFile" --installer-pid $MuseInstallerPid --shortcut-name "${SHORTCUT_NAME}" --app-exe "${PRODUCT_FILENAME}.exe"'
  ${If} ${Errors}
    StrCpy $MuseHostDecision "error"
  ${EndIf}
FunctionEnd

; ──────────────────────────────────────────────────────────────────────
; 等宿主交卷
;
; 三种结局：answers.ini 出现（install）、宿主以 exit=2 退出（cancel）、
; 宿主消失却没有答案（error）。探针用 OpenMutex，句柄每次关闭。
; ──────────────────────────────────────────────────────────────────────
Function MuseWaitForHostDecision
  ${If} $MuseHostDecision == "error"
    Return
  ${EndIf}

  StrCpy $MuseHostDecision ""
  StrCpy $MuseHostSeen "0"
  StrCpy $MuseWaitTicks 0
  ${Do}
    Sleep 150

    ${If} ${FileExists} "$MuseAnswersFile"
      StrCpy $MuseHostDecision "install"
      ${ExitDo}
    ${EndIf}

    Call MuseHostAlive
    ${If} $MuseProbeAlive == "1"
      ; 见过宿主之后，"看不见"才是真的退出；Exec 到宿主创建互斥体之间
      ; 有一段启动窗口，不能把这段当成崩溃。
      StrCpy $MuseHostSeen "1"
    ${Else}
      ${If} $MuseHostSeen == "1"
        ; 宿主已经退出；有 exit=2 回执才算用户取消，其余按启动失败处理。
        StrCpy $MuseHostDecision "error"
        ${If} ${FileExists} "$MuseHostStatusFile"
          FileOpen $0 "$MuseHostStatusFile" r
          ${If} $0 != ""
            FileRead $0 $1
            FileClose $0
            ${TrimNewLines} $1 $1
            ${If} $1 == "exit=2"
              StrCpy $MuseHostDecision "cancel"
            ${EndIf}
          ${EndIf}
        ${EndIf}
        ${ExitDo}
      ${EndIf}

      ; 从没见过宿主（进程启动失败或立刻崩溃）：给它 20 秒，然后报错。
      IntOp $MuseWaitTicks $MuseWaitTicks + 1
      ${If} $MuseWaitTicks > 133
        StrCpy $MuseHostDecision "error"
        ${ExitDo}
      ${EndIf}
    ${EndIf}
  ${Loop}
FunctionEnd

; 安装器侧的存活探针：$MuseProbeAlive = "1" 宿主仍在，"0" 已退出。
; OpenMutex(SYNCHRONIZE, FALSE, name)：存在则拿得到句柄，随即关闭。
;
; 注意：System 插件的 `.r1` 写出的是 `$1`（用户变量），不是 `$R1`（寄存器）。
; 用 `$R1` 读会拿到 NSIS 内部残留值——探针永远"还活着"，安装器就永远不退。
Function MuseHostAlive
  StrCpy $MuseProbeAlive "0"
  System::Call 'kernel32::OpenMutex(i 0x00100000, i 0, t "${MUSE_HOST_MUTEX}") p .r1 ?e'
  Pop $0
  ${If} $1 != 0
    StrCpy $MuseProbeAlive "1"
    System::Call 'kernel32::CloseHandle(p r1)'
  ${EndIf}
FunctionEnd

; 宿主读取的阶段标记，每个阶段只有一行 "phase=<名称>"。
Function MusePublishPhase
  Push $R1
  FileOpen $R1 "$MuseStatusFile" w
  ${If} $R1 != ""
    FileWrite $R1 "phase=$MusePhase$\r$\n"
    FileClose $R1
  ${EndIf}
  Pop $R1
FunctionEnd

; ──────────────────────────────────────────────────────────────────────
; 把宿主的答案落到 NSIS 变量
;
; 约定：answers.ini 由宿主逐行写出 "key=value"，NSIS 只按第一个 '=' 拆分，
; 因而 Windows 路径中的其他等号不会破坏解析。
; ──────────────────────────────────────────────────────────────────────
Function MuseApplyHostAnswers
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
; 桌面图标"选择只写进 answers.ini：electron-builder 的 createDesktopShortcut
; ("always") 与 createStartMenuShortcut 已经按配置建好，为了一个勾选框引入
; "先建再删"不值得——装了应用却少一个图标，比多一个图标更让人困惑。
; 宿主 UI 上的两个勾选框因此标记为"即将生效"，后续版本再接。

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