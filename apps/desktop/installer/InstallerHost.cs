// MusePi Windows installer host — WebView2 shell for the installer UI.
//
// Why this exists: NSIS's own widgets cannot express the client's liquid-glass
// language (rounded cards, blur, spring motion). The client already has that
// language as CSS tokens, so the installer hosts the same HTML/CSS and NSIS
// only owns file placement, registry and shortcuts.
//
// LANGUAGE LEVEL: this file MUST compile with the .NET Framework 4.8 in-box
// compiler (C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe), which
// supports C# 5 only (verified: "/langversion:?" reports "up to C# 5"). That is
// the price of keeping MSVC / Visual Studio out of the Windows release job, so
// this file avoids: ?., $"" interpolation, tuples, nameof, out var,
// expression-bodied members, async Task Main, and nullable reference types.
//
// Protocol (page <-> host)
//   page -> host : drag | minimize | close | finish | launch | cancel
//                  pick-directory | ui-ready | install:<json>
//   host -> page : JSON { type: ready|progress|installed|cancelled|failed|error
//                         |directory-picked }
//
// The host owns progress. A silent NSIS install cannot report a percentage, so
// the host reports the phase the installer marked (install-status.ini) and the
// bytes actually written under the target; the page never invents a number.
//
// Liveness and cancellation
//   The installer holds "Local\MusePi.Installer.Setup" for its lifetime and this
//   host holds "Local\MusePi.Installer.Host". Existence checks use OpenMutex
//   rather than image-name matching, so a same-named process elsewhere cannot
//   pass for the installer. Cancelling terminates the installer with exit code
//   2 (TerminateProcess), then removes a fresh install's files, shortcuts and
//   registry entries; an upgrade cannot be rolled back and says so.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace MusePiInstallerHost
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            Console.OutputEncoding = Encoding.UTF8;
            TryEnablePerMonitorDpi();

            HostOptions options = HostOptions.Parse(args);
            if (options.ShowHelp)
            {
                Console.WriteLine(HostOptions.Usage);
                return 0;
            }
            if (options.SelfTest) return InstallerWindow.SelfTest();
            if (options.CheckRunning) return InstallerWindow.IsClientRunning() ? 10 : 0;
            if (options.SmokeTest) return SmokeTest.Run(options);
            if (options.AutoInstall) return RunAutoInstall(options);

            if (!File.Exists(options.UiIndex))
            {
                ShowFailure("Installer UI not found:\n" + options.UiIndex);
                return 2;
            }

            // The installer's wait loop watches this mutex to learn when the
            // finished page was closed. Held for the life of the process; a
            // failure to create it only costs one fallback (the installer times
            // out after 30 minutes), never the wizard itself.
            Mutex hostMutex = null;
            try { hostMutex = new Mutex(false, InstallerWindow.HostMutexName); }
            catch (Exception) { }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            try
            {
                Application.Run(new InstallerWindow(options));
            }
            finally
            {
                if (hostMutex != null) hostMutex.Dispose();
            }
            return Environment.ExitCode;
        }

        private static void TryEnablePerMonitorDpi()
        {
            try
            {
                SetProcessDpiAwarenessContext(new IntPtr(-4));
            }
            catch (Exception)
            {
                // Older Windows: the manifest declaration still applies.
            }
        }

        private static int RunAutoInstall(HostOptions options)
        {
            try
            {
                string target = InstallerWindow.ResolveDefaultPath(options);
                Directory.CreateDirectory(target);
                InstallerWindow.WriteAnswers(options.AnswersPath, target, "zh-CN", "1", "1");
                Console.WriteLine("[auto-install] answers written for " + target);
                return 0;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("[auto-install] " + ex.GetType().Name + ": " + ex.Message);
                return 1;
            }
        }

        internal static void ShowFailure(string message)
        {
            MessageBox.Show(message, "MusePi Setup", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    }

    internal sealed class HostOptions
    {
        public string UiIndex;
        public string InstallRoot;
        public string AnswersPath;
        public string StatusFile;
        public string HostStatusFile;
        public string ShortcutName;
        public string AppExe;
        public int InstallerPid;
        public bool SmokeTest;
        public bool ShowHelp;
        public bool AutoInstall;
        public bool SelfTest;
        public bool CheckRunning;
        public bool UiFlow;

        /// <summary>
        /// Directory of the installer channel files. The NSIS script passes every
        /// path explicitly; these defaults only serve --auto-install and a manual
        /// launch, and match what the script falls back to.
        /// </summary>
        internal static string DefaultStateDirectory()
        {
            string overrideDirectory = Environment.GetEnvironmentVariable("MUSEPI_ANSWERS_DIR");
            if (!string.IsNullOrEmpty(overrideDirectory)) return overrideDirectory;
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "MusePi",
                "Installer");
        }

        public const string Usage =
            "MusePiInstallerHost.exe --ui <index.html> [options]\n" +
            "  --ui              path to installer/ui/index.html\n" +
            "  --install-root    default target directory shown on the location page\n" +
            "  --answers         answers.ini path written on install (default: state dir)\n" +
            "  --status          install-status.ini the installer writes phases into\n" +
            "  --host-status     host-status.ini this host writes its exit code into\n" +
            "  --installer-pid   process id of the installer, for liveness and cancel\n" +
            "  --shortcut-name   shortcut base name used by a rollback\n" +
            "  --app-exe         application executable name used by a rollback\n" +
            "  --smoke-test      verify the real WebView2 layout and exit\n" +
            "  --auto-install    write answers and exit (NSIS integration test only)\n" +
            "  --check-running   exit 10 when MusePi is running, otherwise 0\n" +
            "  --self-test       verify the exit/status contracts\n" +
            "  --ui-flow         click through the wizard automatically (capture only)";

        public static HostOptions Parse(string[] args)
        {
            HostOptions options = new HostOptions();
            string stateDirectory = DefaultStateDirectory();
            options.UiIndex = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "ui", "index.html");
            options.AnswersPath = Path.Combine(stateDirectory, "answers.ini");
            options.StatusFile = Path.Combine(stateDirectory, "install-status.ini");
            options.HostStatusFile = Path.Combine(stateDirectory, "host-status.ini");
            options.ShortcutName = "MusePi";
            options.AppExe = "MusePi.exe";
            // The NSIS script's command line is fixed, so the capture harness
            // hands this flag to the child process through the environment.
            string uiFlow = Environment.GetEnvironmentVariable("MUSEPI_INSTALLER_UI_FLOW");
            options.UiFlow = !string.IsNullOrEmpty(uiFlow) && uiFlow != "0";
            for (int i = 0; i < args.Length; i++)
            {
                string arg = args[i];
                if (arg == "--ui" && i + 1 < args.Length)
                {
                    options.UiIndex = Path.GetFullPath(args[++i]);
                }
                else if (arg == "--install-root" && i + 1 < args.Length)
                {
                    options.InstallRoot = Path.GetFullPath(args[++i]);
                }
                else if (arg == "--answers" && i + 1 < args.Length)
                {
                    options.AnswersPath = Path.GetFullPath(args[++i]);
                }
                else if (arg == "--status" && i + 1 < args.Length)
                {
                    options.StatusFile = Path.GetFullPath(args[++i]);
                }
                else if (arg == "--host-status" && i + 1 < args.Length)
                {
                    options.HostStatusFile = Path.GetFullPath(args[++i]);
                }
                else if (arg == "--installer-pid" && i + 1 < args.Length)
                {
                    int pid;
                    if (int.TryParse(args[++i], NumberStyles.Integer, CultureInfo.InvariantCulture, out pid)) options.InstallerPid = pid;
                }
                else if (arg == "--shortcut-name" && i + 1 < args.Length)
                {
                    options.ShortcutName = args[++i];
                }
                else if (arg == "--app-exe" && i + 1 < args.Length)
                {
                    options.AppExe = args[++i];
                }
                else if (arg == "--smoke-test") options.SmokeTest = true;
                else if (arg == "--auto-install") options.AutoInstall = true;
                else if (arg == "--check-running") options.CheckRunning = true;
                else if (arg == "--self-test") options.SelfTest = true;
                else if (arg == "--ui-flow") options.UiFlow = true;
                else if (arg == "--help" || arg == "-h") options.ShowHelp = true;
            }
            return options;
        }
    }

    internal sealed class InstallerWindow : Form
    {
        /// <summary>CSS viewport the UI is authored against.</summary>
        private const int ViewWidth = 760;
        private const int ViewHeight = 560;

        /// <summary>Object name shared with installer-branding.nsh (MUSE_HOST_MUTEX).</summary>
        internal const string HostMutexName = "Local\\MusePi.Installer.Host";

        /// <summary>Object name shared with installer-branding.nsh (MUSE_SETUP_MUTEX).</summary>
        internal const string SetupMutexName = "Local\\MusePi.Installer.Setup";

        internal const int ExitSuccess = 0;
        internal const int ExitCancelled = 2;
        internal const int ExitFailed = 3;

        private readonly HostOptions _options;
        private readonly WebView2 _view;
        private volatile bool _installing;
        private volatile bool _cancelRequested;
        private volatile bool _installSucceeded;
        private string _language;
        private string _target;
        private bool _targetHadFiles;
        private DateTime _installStartedUtc;
        private int _exitCode = ExitCancelled;

        /// <summary>
        /// Convert CSS pixels to physical pixels for the current display.
        ///
        /// Uses the SYSTEM DPI rather than a per-window DPI so this can run in the
        /// constructor (before the window handle exists). The installer is a
        /// single small dialog that opens centred on the primary display; a
        /// system-DPI guess is correct there and avoids a second resize pass.
        /// </summary>
        private static Size ScaleToDevicePixels(int cssWidth, int cssHeight)
        {
            double scale = 1.0;
            try
            {
                uint dpi = GetDpiForSystem();
                if (dpi >= 96) scale = dpi / 96.0;
            }
            catch (Exception)
            {
                // Pre-Win10 1607 without GetDpiForSystem: use the DC-based metric,
                // which is virtualised for DPI-unaware processes but this process
                // is aware, so it reports the true value.
                try
                {
                    IntPtr dc = GetDC(IntPtr.Zero);
                    if (dc != IntPtr.Zero)
                    {
                        int logPixels = GetDeviceCaps(dc, LOGPIXELSX);
                        ReleaseDC(IntPtr.Zero, dc);
                        if (logPixels >= 96) scale = logPixels / 96.0;
                    }
                }
                catch (Exception)
                {
                    // Fall through at 1.0: a slightly small window beats no window.
                }
            }

             return new Size(
                (int)Math.Round(cssWidth * scale),
                (int)Math.Round(cssHeight * scale));
        }

        /// <summary>Public seam so the smoke test measures the same viewport users get.</summary>
        internal static Size ScaleToDevicePixelsPublic(int cssWidth, int cssHeight)
        {
            return ScaleToDevicePixels(cssWidth, cssHeight);
        }

        /// <summary>
        /// Resize the mapped window to the DPI-scaled design size via Win32.
        ///
        /// WinForms' own sizing path fights the DPI scaling on this configuration
        /// (a 175% display yields a 760x560 physical window despite ClientSize
        /// being set to 1330x980). SetWindowPos on the real HWND bypasses that and
        /// is the only approach observed to stick.
        /// </summary>
        private void ForceDeviceSize()
        {
            try
            {
                Size target = ScaleToDevicePixels(ViewWidth, ViewHeight);
                // SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE, then centre.
                SetWindowPos(Handle, IntPtr.Zero, 0, 0, target.Width, target.Height,
                    SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
                CenterToScreen();
            }
            catch (Exception)
            {
                // Cosmetic only — never fail the installer over window geometry.
            }
        }

        private const uint SWP_NOMOVE = 0x0002;
        private const uint SWP_NOZORDER = 0x0004;
        private const uint SWP_NOACTIVATE = 0x0010;

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool SetWindowPos(
            IntPtr hWnd, IntPtr hWndInsertAfter, int x, int y, int cx, int cy, uint flags);

        [DllImport("user32.dll")]
        private static extern uint GetDpiForSystem();

        [DllImport("user32.dll")]
        private static extern IntPtr GetDC(IntPtr hwnd);

        [DllImport("user32.dll")]
        private static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);

        [DllImport("gdi32.dll")]
        private static extern int GetDeviceCaps(IntPtr dc, int index);

        private const int LOGPIXELSX = 88;

        public InstallerWindow(HostOptions options)
        {
            _options = options;
            _language = DefaultLanguage();

            // Frameless: the page draws the titlebar. DWM still rounds the
            // corners on Win11; on Win10 the CSS radius inside the page is what
            // the user perceives.
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;

            // AutoScaleMode.None is REQUIRED, not cosmetic. With the inherited
            // (Font) mode, WinForms rescales ClientSize using DeviceDpi, which
            // .NET Framework 4.8 reports as 96 even inside a per-monitor-aware
            // process — so an explicitly DPI-scaled size gets divided back down
            // and the window ends up 760x560 on a 175% display. Verified: with
            // AutoScaleMode.None the same assignment sticks.
            //
            // Everything inside the window is HTML laid out by WebView2 at the CSS
            // viewport size, so WinForms' own scaling has nothing to contribute —
            // the only thing it can do here is fight us.
            AutoScaleMode = AutoScaleMode.None;

            // DESIGN SIZE vs DEVICE PIXELS.
            //
            // The UI is authored against a 760x560 CSS viewport. The process is
            // per-monitor DPI aware (InstallerHost.manifest), so a raw 760x560
            // window on a 175% display yields a CSS viewport of only
            // 760 / 1.75 ≈ 434px: the description wraps onto four lines, the option
            // rows overflow and a horizontal scrollbar appears.
            //
            // Applied BOTH here and in OnShown: WinForms re-applies AutoScaleMode
            // when the handle is created, and .NET Framework 4.8 reports DeviceDpi
            // as 96 even inside a per-monitor-aware process — a constructor-only
            // assignment gets scaled back before the window is visible. Re-applying
            // after Show wins.
            ClientSize = ScaleToDevicePixels(ViewWidth, ViewHeight);
            BackColor = Color.FromArgb(21, 20, 23);
            Text = "MusePi 安装程序";
            DoubleBuffered = true;
            KeyPreview = true;

            _view = new WebView2();
            _view.Dock = DockStyle.Fill;
            Controls.Add(_view);

            // Rounded corners have to be requested from DWM; a borderless
            // WinForms window is square by default and no amount of CSS inside
            // the page can round the actual window edge.
            ApplyDwmWindowChrome();

            StartInstallerMonitor();

            Shown += async delegate
            {
                // Force the DPI-scaled geometry through Win32.
                //
                // Setting Form.ClientSize alone is not enough here: on this
                // 175% display the window comes up at 760x560 physical even though
                // ScaleToDevicePixels() returns 1330x980 (verified at runtime), and
                // neither the constructor assignment nor a BeginInvoke re-set
                // takes effect. SetWindowPos on the mapped HWND does.
                ForceDeviceSize();
                await InitialiseAsync();
            };

            KeyDown += delegate(object sender, KeyEventArgs e)
            {
                if (e.KeyCode == Keys.Escape) Close();
            };

            FormClosing += delegate(object sender, FormClosingEventArgs e)
            {
                // Closing during the install means "cancel it": the install runs in
                // a silent installer that cannot be paused, so the only truthful
                // option is to stop it, undo what this run wrote, and show the
                // result. The window stays open for that result page.
                if (_installing && e.CloseReason == CloseReason.UserClosing)
                {
                    e.Cancel = true;
                    CancelRequested();
                }
            };
            FormClosed += delegate
            {
                Environment.ExitCode = _exitCode;
                WriteHostStatus(_exitCode);
            };
        }

        /// <summary>
        /// Ask DWM to round the window corners and keep the shadow.
        ///
        /// A FormBorderStyle.None window is a plain square rectangle. Windows 11
        /// only rounds windows whose frame it still manages, so we:
        ///   1. re-enable non-client rendering (DWMWA_NCRENDERING_POLICY),
        ///   2. ask for the rounded corner preference (DWMWA_WINDOW_CORNER_PREFERENCE
        ///      = 33, DWMWCP_ROUND = 2),
        ///   3. extend the frame by one pixel so the shadow is drawn.
        /// On Windows 10 step 2 is ignored (no rounded corners there) but steps 1
        /// and 3 still give a clean shadowed edge.
        /// </summary>
        private void ApplyDwmWindowChrome()
        {
            try
            {
                // DWMWA_NCRENDERING_POLICY = 2, DWMNCRP_ENABLED = 2
                int enabled = 2;
                DwmSetWindowAttribute(Handle, 2, ref enabled, sizeof(int));

                // DWMWA_WINDOW_CORNER_PREFERENCE = 33, DWMWCP_ROUND = 2
                int round = 2;
                DwmSetWindowAttribute(Handle, 33, ref round, sizeof(int));

                // Extend the frame so DWM paints the outer shadow.
                MARGINS margins = new MARGINS();
                margins.cxLeftWidth = 1;
                margins.cxRightWidth = 1;
                margins.cyTopHeight = 1;
                margins.cyBottomHeight = 1;
                DwmExtendFrameIntoClientArea(Handle, ref margins);
            }
            catch (Exception)
            {
                // Styling is cosmetic: never fail the installer over it.
            }
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MARGINS
        {
            public int cxLeftWidth;
            public int cxRightWidth;
            public int cyTopHeight;
            public int cyBottomHeight;
        }

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

        [DllImport("dwmapi.dll")]
        private static extern int DwmExtendFrameIntoClientArea(IntPtr hwnd, ref MARGINS margins);

        private async Task InitialiseAsync()
        {
            try
            {
                CoreWebView2Environment environment = await CreateEnvironmentAsync();
                await _view.EnsureCoreWebView2Async(environment);

                CoreWebView2 core = _view.CoreWebView2;
                core.Settings.AreDefaultContextMenusEnabled = false;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.IsZoomControlEnabled = false;
                core.Settings.AreBrowserAcceleratorKeysEnabled = false;
                core.Settings.AreDevToolsEnabled = false;
                core.Settings.IsPasswordAutosaveEnabled = false;
                core.Settings.IsGeneralAutofillEnabled = false;

                core.WebMessageReceived += OnWebMessage;

                string uiDirectory = Path.GetDirectoryName(_options.UiIndex);
                core.SetVirtualHostNameToFolderMapping(
                    "musepi.installer",
                    uiDirectory,
                    CoreWebView2HostResourceAccessKind.Allow);

                core.Navigate("https://musepi.installer/" + Path.GetFileName(_options.UiIndex));
            }
            catch (Exception ex)
            {
                Program.ShowFailure("无法初始化安装界面。\n\n" + ex.GetType().Name + ": " + ex.Message);
                Close();
            }
        }

        /// <summary>
        /// Create the WebView2 environment with a user-data folder that is safe to
        /// write from the install location.
        ///
        /// Why this is not just `CreateAsync(null, null, null)`: with a null folder
        /// WebView2 creates "&lt;host exe&gt;.WebView2" NEXT TO the executable. During
        /// development that is the build directory, which is writable — but the
        /// installer ships inside %ProgramFiles%, where the user has no write
        /// permission, so the default would fail exactly where it matters.
        ///
        /// The preferred location is therefore %LOCALAPPDATA%\MusePi\Installer\WebView2.
        /// If creating a custom environment fails on the running machine (it does on
        /// some hardened Windows images, returning E_UNEXPECTED), fall back to the
        /// default so the wizard still opens instead of dying at startup.
        /// </summary>
        private async Task<CoreWebView2Environment> CreateEnvironmentAsync()
        {
            string customFolder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "MusePi",
                "Installer",
                "WebView2");

            // C# 5 forbids `await` inside a catch block, so the failure is recorded
            // and handled after the try/catch.
            CoreWebView2Environment custom = null;
            Exception failure = null;
            try
            {
                Directory.CreateDirectory(customFolder);
                custom = await CoreWebView2Environment.CreateAsync(null, customFolder, null);
            }
            catch (Exception ex)
            {
                failure = ex;
            }

            if (custom != null) return custom;

            // Degrade rather than fail: the exe-adjacent default works whenever the
            // host itself sits in a writable directory (dev builds, or the
            // extracted-to-TEMP case that NSIS performs before launching us).
            Console.Error.WriteLine(
                "[host] custom user-data folder unavailable ("
                + (failure == null ? "unknown" : failure.GetType().Name)
                + "), falling back to default: "
                + (failure == null ? "" : failure.Message));
            return await CoreWebView2Environment.CreateAsync(null, null, null);
        }

        private void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            string message;
            try { message = e.TryGetWebMessageAsString(); }
            catch { return; }

            if (message.StartsWith("install:", StringComparison.Ordinal))
            {
                RunInstall(message.Substring("install:".Length));
                return;
            }
            if (message.StartsWith("language:", StringComparison.Ordinal))
            {
                SetLanguage(message.Substring("language:".Length));
                return;
            }
            if (message == "ui-ready")
            {
                Post("{\"type\":\"ready\",\"appVersion\":\"" + Escape(AppVersion())
                     + "\",\"defaultPath\":\"" + Escape(DefaultInstallPath())
                     + "\",\"language\":\"" + Escape(_language) + "\"}");
                if (_options.UiFlow) StartHarnessFlow();
                return;
            }

            switch (message)
            {
                case "drag":
                    ReleaseCapture();
                    SendMessage(Handle, WM_NCLBUTTONDOWN, (IntPtr)HTCAPTION, IntPtr.Zero);
                    break;
                case "minimize":
                    WindowState = FormWindowState.Minimized;
                    break;
                case "close":
                case "finish":
                    Close();
                    break;
                case "launch":
                    LaunchInstalled();
                    Close();
                    break;
                case "cancel":
                    CancelRequested();
                    break;
                case "pick-directory":
                    PickDirectory();
                    break;
            }
        }

        /// <summary>Minimal JSON string escaping — these payloads are paths and status text.</summary>
        private static string Escape(string value)
        {
            if (value == null) return "";
            return value
                .Replace("\\", "\\\\")
                .Replace("\"", "\\\"")
                .Replace("\r", "\\r")
                .Replace("\n", "\\n")
                .Replace("\t", "\\t");
        }

        private string AppVersion()
        {
            FileVersionInfo version = FileVersionInfo.GetVersionInfo(Application.ExecutablePath);
            if (string.IsNullOrEmpty(version.ProductVersion)) return "0.0.0";
            return version.ProductVersion;
        }

        internal static string ResolveDefaultPath(HostOptions options)
        {
            if (!string.IsNullOrEmpty(options.InstallRoot)) return options.InstallRoot;
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs",
                "MusePi");
        }

        private string DefaultInstallPath()
        {
            if (!string.IsNullOrEmpty(_options.InstallRoot)) return _options.InstallRoot;
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs",
                "MusePi");
        }

        private static string DefaultLanguage()
        {
            string name = CultureInfo.CurrentUICulture.Name;
            if (name.StartsWith("zh-TW", StringComparison.OrdinalIgnoreCase)
                || name.StartsWith("zh-HK", StringComparison.OrdinalIgnoreCase)
                || name.StartsWith("zh-Hant", StringComparison.OrdinalIgnoreCase)) return "zh-TW";
            if (name.StartsWith("zh", StringComparison.OrdinalIgnoreCase)) return "zh-CN";
            return "en-US";
        }

        private static string NormaliseLanguage(string language)
        {
            if (language == "zh-CN" || language == "zh-TW") return language;
            return "en-US";
        }

        private void SetLanguage(string language)
        {
            _language = NormaliseLanguage(language);
            Text = Localized("windowTitle");
        }

        /// <summary>
        /// Native-only strings. Everything the page renders is localized in
        /// installer-locales.js, so the two catalogs never drift.
        /// </summary>
        private string Localized(string key)
        {
            if (_language == "zh-TW")
            {
                if (key == "pickDirectory") return "選擇 MusePi 的安裝位置";
                return "MusePi 安裝程式";
            }
            if (_language == "zh-CN")
            {
                if (key == "pickDirectory") return "选择 MusePi 的安装位置";
                return "MusePi 安装程序";
            }
            if (key == "pickDirectory") return "Choose the MusePi install location";
            return "MusePi Setup";
        }

        private void PickDirectory()
        {
            using (FolderBrowserDialog dialog = new FolderBrowserDialog())
            {
                dialog.Description = Localized("pickDirectory");
                dialog.SelectedPath = DefaultInstallPath();
                if (dialog.ShowDialog(this) == DialogResult.OK)
                {
                    Post("{\"type\":\"directory-picked\",\"path\":\""
                         + Escape(Path.Combine(dialog.SelectedPath, "MusePi")) + "\"}");
                }
            }
        }

        private void RunInstall(string json)
        {
            string target = DefaultInstallPath();
            string desktopShortcut = "1";
            string startMenu = "1";
            try
            {
                JavaScriptSerializer serializer = new JavaScriptSerializer();
                Dictionary<string, object> payload =
                    serializer.Deserialize<Dictionary<string, object>>(json);
                if (payload != null)
                {
                    string value = GetString(payload, "path");
                    if (!string.IsNullOrEmpty(value)) target = value;
                    value = GetString(payload, "language");
                    if (!string.IsNullOrEmpty(value)) SetLanguage(value);
                    desktopShortcut = GetBoolFlag(payload, "desktopShortcut");
                    startMenu = GetBoolFlag(payload, "startMenu");
                }
            }
            catch (Exception)
            {
                // Keep the current language and defaults for a malformed payload.
            }

            if (_installing) return;
            _installing = true;
            _cancelRequested = false;
            _installSucceeded = false;
            _exitCode = ExitCancelled;
            _installStartedUtc = DateTime.UtcNow;
            Post("{\"type\":\"progress\",\"phase\":\"preparing\"}");

            Thread worker = new Thread(delegate() { PrepareAndInstall(target, desktopShortcut, startMenu); });
            worker.IsBackground = true;
            worker.Start();
        }

        /// <summary>
        /// Validate, hand the answers to the installer, then follow the silent
        /// install until the installer marks it done. Runs off the UI thread.
        /// </summary>
        private void PrepareAndInstall(string target, string desktopShortcut, string startMenu)
        {
            try
            {
                if (IsClientRunningUnder(target))
                {
                    throw new SetupBlockedException(
                        "clientRunning",
                        "MusePi is running from the install folder. Close it, then retry.");
                }

                _target = target;
                _targetHadFiles = DirectoryHasFiles(target);
                ValidateDirectory(target);
                WriteAnswers(_options.AnswersPath, target, _language, desktopShortcut, startMenu);
                Post("{\"type\":\"progress\",\"phase\":\"awaiting\"}");
                WatchInstall();
            }
            catch (SetupBlockedException blocked)
            {
                _installing = false;
                Post("{\"type\":\"error\",\"reason\":\"" + Escape(blocked.Reason) + "\"}");
                CapturePageAfter("9-error", 400);
            }
            catch (Exception error)
            {
                _installing = false;
                Post("{\"type\":\"error\",\"reason\":\"directory\",\"message\":\""
                     + Escape(error.Message) + "\"}");
                Console.Error.WriteLine("[install] " + error.GetType().Name + ": " + error.Message);
                CapturePageAfter("9-error", 400);
            }
        }

        /// <summary>
        /// The installer runs its own sections silently; it cannot report how far
        /// a File copy has got. So this reports what is observable and true: the
        /// phase the installer published, and the bytes that actually exist under
        /// the target directory. No percentage is invented.
        /// </summary>
        private void WatchInstall()
        {
            string lastPhase = "";
            long lastBytes = -1;
            DateTime lastMeasure = DateTime.MinValue;
            DateTime started = DateTime.UtcNow;

            while (true)
            {
                if (_cancelRequested)
                {
                    CancelInstall();
                    return;
                }

                string phase = InstallerStatus.ReadPhase(_options.StatusFile);
                if (phase == "done")
                {
                    Succeed();
                    return;
                }

                if (!InstallerAlive())
                {
                    // The installer writes "done" before it can exit, so a late
                    // write between these two reads is still a success.
                    Thread.Sleep(400);
                    if (InstallerStatus.ReadPhase(_options.StatusFile) == "done")
                    {
                        Succeed();
                        return;
                    }
                    FailInstall("installerExited");
                    return;
                }

                if (phase == "installing" && lastPhase != "installing")
                {
                    lastPhase = "installing";
                    Post("{\"type\":\"progress\",\"phase\":\"installing\"}");
                    CapturePageAfter("3-progress", 900);
                }

                if (phase == "" && (DateTime.UtcNow - started).TotalSeconds > 180)
                {
                    // No answers were applied and no liveness signal was given:
                    // this host was launched outside an installer that drives it.
                    FailInstall("installerSilent");
                    return;
                }

                if (phase == "installing"
                    && (DateTime.UtcNow - lastMeasure).TotalMilliseconds >= 900)
                {
                    lastMeasure = DateTime.UtcNow;
                    long bytes = MeasureBytes(_target);
                    if (bytes > 0 && bytes != lastBytes)
                    {
                        lastBytes = bytes;
                        Post("{\"type\":\"progress\",\"phase\":\"installing\",\"bytes\":" + bytes + "}");
                    }
                }

                Thread.Sleep(180);
            }
        }

        private void Succeed()
        {
            _installSucceeded = true;
            _installing = false;
            _exitCode = ExitSuccess;
            Post("{\"type\":\"installed\",\"path\":\"" + Escape(_target) + "\"}");
            if (_options.UiFlow)
            {
                CapturePageAfter("4-finish", 500);
                CloseAfterDelay(3000);
            }
        }

        private void FailInstall(string reason)
        {
            bool upgrade = _targetHadFiles;
            Rollback(_target, !upgrade);
            _installing = false;
            _exitCode = ExitFailed;
            Post("{\"type\":\"failed\",\"reason\":\"" + Escape(reason)
                 + "\",\"upgrade\":" + (upgrade ? "true" : "false") + "}");
        }

        private void CancelRequested()
        {
            if (!_installing || _cancelRequested) return;
            _cancelRequested = true;
            Post("{\"type\":\"progress\",\"phase\":\"cancelling\"}");
        }

        private void CancelInstall()
        {
            // TerminateProcess with our documented cancel code: the installer has
            // no interrupt point inside its File section, so a signal-based cancel
            // would lie about stopping it.
            TerminateInstaller(ExitCancelled);
            bool upgrade = _targetHadFiles;
            Rollback(_target, !upgrade);
            _installing = false;
            _exitCode = ExitCancelled;
            Post("{\"type\":\"cancelled\",\"upgrade\":" + (upgrade ? "true" : "false") + "}");
        }

        private void CloseAfterDelay(int milliseconds)
        {
            try
            {
                Thread closeThread = new Thread(delegate()
                {
                    Thread.Sleep(milliseconds);
                    try { BeginInvoke(new Action(delegate { Close(); })); }
                    catch (Exception) { }
                });
                closeThread.IsBackground = true;
                closeThread.Start();
            }
            catch (Exception) { }
        }

        private void LaunchInstalled()
        {
            if (!_installSucceeded || string.IsNullOrEmpty(_target)) return;
            try
            {
                string executable = Path.Combine(_target, _options.AppExe);
                if (!File.Exists(executable)) return;
                ProcessStartInfo start = new ProcessStartInfo();
                start.FileName = executable;
                start.WorkingDirectory = _target;
                start.UseShellExecute = true;
                Process.Start(start);
            }
            catch (Exception)
            {
                // A launch failure must not turn a completed install into an error.
            }
        }

        /// <summary>
        /// Undo what this run created. A fresh install is removed completely; an
        /// upgrade keeps the (partially replaced) directory because deleting it
        /// would also delete the working version the user had before, and there is
        /// no staging copy to restore. The UI says exactly which case happened.
        /// </summary>
        private void Rollback(string target, bool removeFiles)
        {
            if (string.IsNullOrEmpty(target)) return;

            try
            {
                if (removeFiles && Directory.Exists(target)) Directory.Delete(target, true);
            }
            catch (Exception) { }

            RemoveShortcuts(target);
            RemoveRegistryInstallInfo(target);
        }

        private void RemoveShortcuts(string target)
        {
            try
            {
                if (File.Exists(Path.Combine(target, _options.AppExe))) return;
            }
            catch (Exception) { }

            string[] links = new string[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
                    _options.ShortcutName + ".lnk"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs),
                    _options.ShortcutName + ".lnk"),
            };
            foreach (string link in links)
            {
                try
                {
                    if (!File.Exists(link)) continue;
                    // Only a link created during this run belongs to it; an older
                    // install elsewhere keeps its own shortcut.
                    if (File.GetLastWriteTimeUtc(link) < _installStartedUtc) continue;
                    File.Delete(link);
                }
                catch (Exception) { }
            }
        }

        private static void RemoveRegistryInstallInfo(string target)
        {
            const string uninstallRoot = @"Software\Microsoft\Windows\CurrentVersion\Uninstall";
            RemoveMatchingInstallLocation(uninstallRoot, target);
            try
            {
                using (RegistryKey software = Registry.CurrentUser.OpenSubKey("Software"))
                {
                    if (software == null) return;
                    foreach (string name in software.GetSubKeyNames())
                    {
                        RemoveMatchingInstallLocation("Software\\" + name, target);
                    }
                }
            }
            catch (Exception) { }
        }

        private static void RemoveMatchingInstallLocation(string path, string target)
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(path))
                {
                    if (key == null) return;
                    string location = key.GetValue("InstallLocation") as string;
                    if (location == null) return;
                    if (!string.Equals(location.Trim().TrimEnd('\\'), target.Trim().TrimEnd('\\'),
                            StringComparison.OrdinalIgnoreCase)) return;
                }
                Registry.CurrentUser.DeleteSubKeyTree(path, false);
            }
            catch (Exception) { }
        }

        private void TerminateInstaller(int exitCode)
        {
            if (_options.InstallerPid <= 0) return;
            IntPtr handle = OpenProcess(PROCESS_TERMINATE, false, _options.InstallerPid);
            if (handle != IntPtr.Zero)
            {
                TerminateProcess(handle, (uint)exitCode);
                CloseHandle(handle);
            }
            DateTime deadline = DateTime.UtcNow.AddSeconds(5);
            while (DateTime.UtcNow < deadline && InstallerAlive())
            {
                Thread.Sleep(100);
            }
        }

        /// <summary>
        /// The installer creates "Local\MusePi.Installer.Setup" in customInit and
        /// keeps the handle for its lifetime. A missing object is the only truthful
        /// "it is gone": PIDs are reused, and an image-name scan matches processes
        /// from a different install directory.
        /// </summary>
        private static bool InstallerAlive()
        {
            IntPtr handle = OpenMutex(SYNCHRONIZE, false, SetupMutexName);
            if (handle == IntPtr.Zero) return false;
            CloseHandle(handle);
            return true;
        }

        private static bool DirectoryHasFiles(string path)
        {
            try
            {
                if (!Directory.Exists(path)) return false;
                using (IEnumerator<string> entries = Directory.EnumerateFileSystemEntries(path).GetEnumerator())
                {
                    return entries.MoveNext();
                }
            }
            catch (Exception)
            {
                return false;
            }
        }

        private static long MeasureBytes(string path)
        {
            if (string.IsNullOrEmpty(path)) return 0;
            long total = 0;
            try
            {
                DirectoryInfo root = new DirectoryInfo(path);
                if (!root.Exists) return 0;
                foreach (FileInfo file in root.EnumerateFiles("*", SearchOption.AllDirectories))
                {
                    try { total += file.Length; }
                    catch (Exception) { }
                }
            }
            catch (Exception) { }
            return total;
        }

        private void WriteHostStatus(int exitCode)
        {
            if (string.IsNullOrEmpty(_options.HostStatusFile)) return;
            try
            {
                string directory = Path.GetDirectoryName(_options.HostStatusFile);
                if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
                File.WriteAllText(
                    _options.HostStatusFile,
                    "exit=" + exitCode.ToString(CultureInfo.InvariantCulture) + "\r\n",
                    new UTF8Encoding(false));
            }
            catch (Exception) { }
        }

        /// <summary>
        /// Write the wizard's answers where NSIS can read them.
        ///
        /// Format is line-oriented "key=value" (answers.ini) rather than JSON:
        /// NSIS has no JSON parser, and hand-rolling one in NSIS script is where
        /// installers get subtle bugs. Only the FIRST '=' splits a line, so
        /// Windows paths containing '=' survive.
        ///
        /// The installer passes the exact path, so both sides always agree; the
        /// write goes through a temp file and a rename because NSIS polls for the
        /// file's existence and must never read a half-written line.
        /// </summary>
        internal static void WriteAnswers(
            string answersFile, string path, string language, string desktopShortcut, string startMenu)
        {
            if (string.IsNullOrEmpty(answersFile))
            {
                answersFile = Path.Combine(HostOptions.DefaultStateDirectory(), "answers.ini");
            }
            string directory = Path.GetDirectoryName(answersFile);
            if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);

            StringBuilder builder = new StringBuilder();
            builder.AppendLine("path=" + path);
            builder.AppendLine("language=" + language);
            builder.AppendLine("desktopShortcut=" + desktopShortcut);
            builder.AppendLine("startMenu=" + startMenu);

            string staging = answersFile + ".tmp";
            File.WriteAllText(staging, builder.ToString(), new UTF8Encoding(false));
            if (File.Exists(answersFile)) File.Delete(answersFile);
            File.Move(staging, answersFile);
        }

        private static string GetString(Dictionary<string, object> payload, string key)
        {
            object value;
            if (!payload.TryGetValue(key, out value) || value == null) return null;
            return value as string;
        }

        /// <summary>Normalize a JSON boolean to the "1"/"0" NSIS compares against.</summary>
        private static string GetBoolFlag(Dictionary<string, object> payload, string key)
        {
            object value;
            if (!payload.TryGetValue(key, out value) || value == null) return "1";
            if (value is bool) return ((bool)value) ? "1" : "0";
            return "1";
        }

        private static void ValidateDirectory(string target)
        {
            Directory.CreateDirectory(target);
            string probe = Path.Combine(target, ".musepi-install-probe");
            File.WriteAllText(probe, DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture));
            File.Delete(probe);
        }

        internal static bool IsClientRunning()
        {
            Process[] processes = Process.GetProcessesByName("MusePi");
            try { return processes.Length > 0; }
            finally
            {
                foreach (Process process in processes) process.Dispose();
            }
        }

        /// <summary>
        /// Only a client running FROM the target directory locks the files this
        /// install replaces. Refusing because MusePi runs anywhere would block a
        /// side-by-side install (and the preview harness, which installs into a
        /// scratch directory while the developer has the app open). This matches
        /// ensure-shortcuts.nsh's customCheckAppRunning, which also filters by
        /// executable path instead of image name.
        /// </summary>
        internal static bool IsClientRunningUnder(string target)
        {
            if (string.IsNullOrEmpty(target)) return IsClientRunning();
            string prefix = target.TrimEnd('\\') + "\\";
            Process[] processes = Process.GetProcessesByName("MusePi");
            try
            {
                foreach (Process process in processes)
                {
                    string path = null;
                    try { path = process.MainModule == null ? null : process.MainModule.FileName; }
                    catch (Exception) { }
                    if (path != null && path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return true;
                }
                return false;
            }
            finally
            {
                foreach (Process process in processes) process.Dispose();
            }
        }

        internal static void EnsureClientNotRunning(Func<bool> probe, string message, string reason)
        {
            if (probe()) throw new SetupBlockedException(reason, message);
        }

        internal static int SelfTest()
        {
            EnsureClientNotRunning(delegate { return false; }, "not running", "clientRunning");
            bool blocked = false;
            try { EnsureClientNotRunning(delegate { return true; }, "running", "clientRunning"); }
            catch (InvalidOperationException ex) { blocked = ex.Message == "running"; }
            if (!blocked) throw new InvalidOperationException("running client was not blocked");

            int attempts = 0;
            Func<bool> retryProbe = delegate { attempts++; return attempts == 1; };
            try { EnsureClientNotRunning(retryProbe, "close before retry", "clientRunning"); }
            catch (InvalidOperationException) { }
            EnsureClientNotRunning(retryProbe, "close before retry", "clientRunning");
            if (attempts != 2) throw new InvalidOperationException("retry probe did not run twice");

            if (ExitSuccess != 0 || ExitCancelled != 2 || ExitFailed != 3)
                throw new InvalidOperationException("exit-code contract changed");

            string statusFile = Path.Combine(
                Path.GetTempPath(), "musepi-host-self-test-" + Guid.NewGuid().ToString("N") + ".ini");
            try
            {
                File.WriteAllText(statusFile, "phase=installing\r\n", new UTF8Encoding(false));
                if (InstallerStatus.ReadPhase(statusFile) != "installing")
                    throw new InvalidOperationException("status phase was not read back");
                File.WriteAllText(statusFile, "phase=do", new UTF8Encoding(false));
                if (InstallerStatus.ReadPhase(statusFile) != "do")
                    throw new InvalidOperationException("partial phase was not tolerated");
            }
            finally
            {
                try { File.Delete(statusFile); }
                catch (Exception) { }
            }

            Console.WriteLine("installer host self-test: PASS");
            return 0;
        }

        private const int PROCESS_TERMINATE = 0x0001;
        private const int SYNCHRONIZE = 0x00100000;

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr OpenMutex(uint access, bool inheritHandle, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(int access, bool inheritHandle, int processId);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateProcess(IntPtr process, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        /// <summary>
        /// While the wizard is still asking questions, a vanished installer means
        /// it gave up (bad payload, WebView2 missing, another instance) and quit.
        /// This host must not survive that: it holds the host mutex, and an orphan
        /// would make the next installer believe its own host is still running.
        /// Once the install starts, WatchInstall owns liveness instead.
        /// </summary>
        private void StartInstallerMonitor()
        {
            if (_options.InstallerPid <= 0) return;
            Thread thread = new Thread(delegate()
            {
                while (!_installing)
                {
                    Thread.Sleep(700);
                    if (_installing) return;
                    if (InstallerAlive()) continue;
                    _exitCode = ExitFailed;
                    try { BeginInvoke(new Action(delegate { Close(); })); }
                    catch (Exception) { }
                    return;
                }
            });
            thread.IsBackground = true;
            thread.Start();
        }

        /// <summary>
        /// Capture harness only (--ui-flow): clicks Continue and Install on the
        /// real page so the capture script can screenshot each stage without
        /// driving WebView2 from outside. Never enabled by the installer.
        /// </summary>
        private void StartHarnessFlow()
        {
            Thread thread = new Thread(delegate()
            {
                Thread.Sleep(700);
                CapturePage("1-language");
                Thread.Sleep(700);
                ExecuteScript("document.querySelector('[data-next=\"location\"]').click()");
                Thread.Sleep(1200);
                CapturePage("2-location");
                Thread.Sleep(400);
                ExecuteScript("var b = document.getElementById('btn-install'); if (b) b.click()");
            });
            thread.IsBackground = true;
            thread.Start();
        }

        /// <summary>
        /// Capture the real WebView2 surface to PNG when the capture harness sets
        /// MUSEPI_INSTALLER_CAPTURE_DIR. Screen capture from another process is not
        /// reliable for a GPU-composited WebView2 (it can come back black), and the
        /// page pixels are the evidence that matters here.
        /// </summary>
        private void CapturePage(string name)
        {
            string directory = Environment.GetEnvironmentVariable("MUSEPI_INSTALLER_CAPTURE_DIR");
            if (string.IsNullOrEmpty(directory)) return;
            if (InvokeRequired)
            {
                try { BeginInvoke(new Action(delegate { CapturePage(name); })); }
                catch (Exception) { }
                return;
            }
            try
            {
                CoreWebView2 core = _view.CoreWebView2;
                if (core == null) return;
                Directory.CreateDirectory(directory);
                FileStream stream = File.Create(Path.Combine(directory, name + ".png"));
                Task capture = core.CapturePreviewAsync(
                    CoreWebView2CapturePreviewImageFormat.Png, stream);
                capture.ContinueWith(delegate(Task finished)
                {
                    try { stream.Dispose(); }
                    catch (Exception) { }
                    if (finished.IsFaulted && finished.Exception != null)
                    {
                        Console.Error.WriteLine("[capture] " + name + " failed: "
                            + finished.Exception.GetBaseException().Message);
                    }
                });
            }
            catch (Exception error)
            {
                Console.Error.WriteLine("[capture] " + name + ": " + error.Message);
            }
        }

        private void CapturePageAfter(string name, int milliseconds)
        {
            Thread thread = new Thread(delegate()
            {
                Thread.Sleep(milliseconds);
                CapturePage(name);
            });
            thread.IsBackground = true;
            thread.Start();
        }

        private void ExecuteScript(string script)
        {
            if (InvokeRequired)
            {
                try { BeginInvoke(new Action(delegate { ExecuteScript(script); })); }
                catch (Exception) { }
                return;
            }
            try
            {
                if (_view.CoreWebView2 != null) _view.CoreWebView2.ExecuteScriptAsync(script);
            }
            catch (Exception) { }
        }

        private void Post(string json)
        {
            if (InvokeRequired)
            {
                BeginInvoke(new Action(delegate { PostOnUiThread(json); }));
            }
            else
            {
                PostOnUiThread(json);
            }
        }

        private void PostOnUiThread(string json)
        {
            if (_view.CoreWebView2 != null)
            {
                _view.CoreWebView2.PostWebMessageAsJson(json);
            }
        }

        private const int WM_NCLBUTTONDOWN = 0xA1;
        private const int HTCAPTION = 0x2;

        [DllImport("user32.dll")]
        private static extern bool ReleaseCapture();

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
    }

    /// <summary>
    /// A pre-install check refused to start. The page maps the reason to its own
    /// localized copy; the message stays for logs.
    /// </summary>
    internal sealed class SetupBlockedException : InvalidOperationException
    {
        public readonly string Reason;

        public SetupBlockedException(string reason, string message) : base(message)
        {
            Reason = reason;
        }
    }

    /// <summary>
    /// The installer's phase file (install-status.ini). It is written by NSIS with
    /// FileOpen/FileWrite, so a read can land on a partial line: only an exact
    /// "phase=..." line counts, and a half-written value reads as no phase.
    /// </summary>
    internal static class InstallerStatus
    {
        public static string ReadPhase(string path)
        {
            if (string.IsNullOrEmpty(path)) return "";
            string text = ReadTextShared(path);
            if (text == null) return "";
            foreach (string raw in text.Split('\n'))
            {
                string line = raw.Trim();
                if (line.StartsWith("phase=", StringComparison.Ordinal))
                {
                    return line.Substring("phase=".Length).Trim();
                }
            }
            return "";
        }

        private static string ReadTextShared(string path)
        {
            try
            {
                using (FileStream stream = new FileStream(
                    path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
                {
                    return reader.ReadToEnd();
                }
            }
            catch (Exception)
            {
                return null;
            }
        }
    }

    /// <summary>
    /// Headless verification used by the build gate and CI: proves WebView2 binds,
    /// the UI loads, and backdrop-filter is actually active in the embedded
    /// compositor (the whole reason for choosing this stack).
    /// </summary>
    internal static class SmokeTest
    {
        /// <summary>
        /// True when the CSS viewport stayed near the 760x560 the UI is authored
        /// against. A 175% display previously collapsed it to ~434 after DPI
        /// awareness was enabled but before the window was scaled.
        /// </summary>
        private static bool ViewportIsUsable(string raw)
        {
            int marker = raw.IndexOf("viewport", StringComparison.Ordinal);
            if (marker < 0) return false;

            // Scan the payload after "viewport" for the "<width>x<height>" pair.
            // ExecuteScriptAsync JSON-encodes its result, so the shape on the wire
            // is: \"viewport\":\"761x560\"
            int width = 0;
            int height = 0;
            bool sawSeparator = false;
            bool inWidth = false;

            for (int i = marker + "viewport".Length; i < raw.Length; i++)
            {
                char c = raw[i];
                if (char.IsDigit(c))
                {
                    if (!sawSeparator)
                    {
                        inWidth = true;
                        width = width * 10 + (c - '0');
                    }
                    else
                    {
                        height = height * 10 + (c - '0');
                    }
                }
                else if (c == 'x' && inWidth && !sawSeparator)
                {
                    sawSeparator = true;
                }
                else if (sawSeparator && height > 0)
                {
                    break;
                }
            }

            // 700..820 / 500..620: comfortably above the collapsed ~434 and below
            // an absurd span, tolerant of DPI rounding.
            return sawSeparator
                   && width >= 700 && width <= 820
                   && height >= 500 && height <= 620;
        }

        public static int Run(HostOptions options)
        {
            int exitCode = 1;
            try
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);

                Form form = new Form();
                // Match the production host before assigning the scaled size;
                // WinForms font auto-scaling otherwise changes the CSS viewport.
                form.AutoScaleMode = AutoScaleMode.None;
                form.ClientSize = InstallerWindow.ScaleToDevicePixelsPublic(760, 560);
                form.StartPosition = FormStartPosition.CenterScreen;
                form.ShowInTaskbar = false;

                WebView2 view = new WebView2();
                view.Dock = DockStyle.Fill;
                form.Controls.Add(view);

                // Hard timeout. On a CI runner a stalled WebView2 (missing
                // runtime, blocked cache directory, no desktop session) would
                // otherwise hang the packaging job until the workflow timeout.
                // Exiting with a clear message turns that into a fast failure.
                System.Windows.Forms.Timer guard = new System.Windows.Forms.Timer();
                guard.Interval = 45000;
                guard.Tick += delegate
                {
                    guard.Stop();
                    Console.Error.WriteLine("[smoke] TIMEOUT after 45s — WebView2 did not finish initialising");
                    try { form.Close(); } catch (Exception) { }
                };
                guard.Start();

                form.Shown += async delegate
                {
                    try
                    {
                        CoreWebView2Environment environment =
                            await CoreWebView2Environment.CreateAsync(null, null, null);
                        await view.EnsureCoreWebView2Async(environment);
                        CoreWebView2 core = view.CoreWebView2;

                        string uiDirectory = Path.GetDirectoryName(options.UiIndex);
                        core.SetVirtualHostNameToFolderMapping(
                            "musepi.installer", uiDirectory, CoreWebView2HostResourceAccessKind.Allow);

                        TaskCompletionSource<bool> navigated = new TaskCompletionSource<bool>();
                        core.NavigationCompleted += delegate(object s, CoreWebView2NavigationCompletedEventArgs ne)
                        {
                            navigated.TrySetResult(ne.IsSuccess);
                        };
                        core.Navigate("https://musepi.installer/" + Path.GetFileName(options.UiIndex));

                        if (!await navigated.Task)
                        {
                            Console.Error.WriteLine("[smoke] navigation failed");
                            exitCode = 1;
                            return;
                        }

                        await Task.Delay(900);

                        // Assert the LAYOUT CONTRACT, not just that a window opened.
                        // The CSS viewport must stay at the designed 760x560 on every
                        // display: without DPI scaling a 175% monitor reported
                        // innerWidth ≈ 434, which wrapped the description onto four
                        // lines and pushed the option rows out of view.
                        //
                        // The glass contract: the shared workspace layer (.shell)
                        // carries the blur, the sidebar is transparent over it, and
                        // the content card floats with its own smaller blur.
                        string script =
                            "document.querySelector('[data-lang=\"zh-TW\"]').click();" +
                            "JSON.stringify({" +
                            "viewport: innerWidth + 'x' + innerHeight," +
                            "traditionalTitle: document.getElementById('h-language').textContent," +
                            "shellGlass: getComputedStyle(document.querySelector('.shell')).backdropFilter," +
                            "cardGlass: getComputedStyle(document.querySelector('.content')).backdropFilter," +
                            "sidebarTransparent: getComputedStyle(document.querySelector('.brandpane')).backgroundColor," +
                            "checkedOptions: document.querySelectorAll('.langs [aria-checked=\"true\"]').length," +
                            "pageCount: document.querySelectorAll('.page').length," +
                            "barBusy: document.getElementById('bar').getAttribute('aria-busy')," +
                            "percentGone: !document.getElementById('progress-percent')," +
                            "noHScroll: document.documentElement.scrollWidth <= innerWidth," +
                            "title: document.title})";
                        string raw = await core.ExecuteScriptAsync(script);
                        Console.WriteLine("[smoke] " + raw);

                        // ExecuteScriptAsync wraps the result in a JSON string
                        // literal, so quotes inside arrive backslash-escaped.
                        //
                        // Viewport is asserted as a RANGE around 760, not an exact
                        // match: DPI scaling rounds to whole device pixels, so a
                        // 175% display legitimately yields 761. What matters is that
                        // the CSS viewport stayed near the authored size instead of
                        // collapsing to ~434 (the pre-fix value on that display).
                        bool ok = ViewportIsUsable(raw)
                                  && raw.Contains("shellGlass\\\":\\\"blur(")
                                  && raw.Contains("cardGlass\\\":\\\"blur(")
                                  && raw.Contains("checkedOptions\\\":1")
                                  && raw.Contains("traditionalTitle\\\":\\\"選擇語言")
                                  && raw.Contains("pageCount\\\":5")
                                  && raw.Contains("barBusy\\\":\\\"true")
                                  && raw.Contains("percentGone\\\":true")
                                  && raw.Contains("noHScroll\\\":true");
                        Console.WriteLine(ok ? "[smoke] PASS" : "[smoke] FAIL");
                        exitCode = ok ? 0 : 1;
                    }
                    catch (Exception ex)
                    {
                        Console.Error.WriteLine("[smoke] " + ex.GetType().Name + ": " + ex.Message);
                        exitCode = 1;
                    }
                    finally
                    {
                        form.Close();
                    }
                };

                Application.Run(form);
                return exitCode;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("[smoke] fatal: " + ex);
                return 1;
            }
        }
    }
}
