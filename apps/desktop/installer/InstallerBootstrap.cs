using System;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace MusePiInstallerBootstrap
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            if (args.Length == 1 && args[0] == "--self-test") return SelfTest();

            string workDir = null;
            try
            {
                string localData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                if (string.IsNullOrEmpty(localData)) localData = Path.GetFullPath(".");
                workDir = Path.Combine(localData, "MusePi", "Installer", Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(workDir);

                string payload = Path.Combine(workDir, "MusePiSetup.exe");
                using (Stream source = Assembly.GetExecutingAssembly().GetManifestResourceStream("Payload"))
                using (FileStream target = File.Create(payload))
                {
                    if (source == null) throw new InvalidOperationException("Embedded installer payload is missing");
                    source.CopyTo(target);
                }

                // The installer reads its answers/status channel from this directory, so
                // it lives and dies with this run: a cancelled install cannot leave
                // stale answers behind in %LOCALAPPDATA%.
                string stateDir = Path.Combine(workDir, "state");
                Directory.CreateDirectory(stateDir);

                ProcessStartInfo start = new ProcessStartInfo();
                start.FileName = payload;
                start.WorkingDirectory = workDir;
                start.UseShellExecute = false;
                start.CreateNoWindow = true;
                start.Arguments = JoinArguments(args);
                start.EnvironmentVariables["TEMP"] = workDir;
                start.EnvironmentVariables["TMP"] = workDir;
                start.EnvironmentVariables["MUSEPI_ANSWERS_DIR"] = stateDir;
                bool silent = IsSilentRun(args);
                using (Process process = Process.Start(start))
                {
                    process.WaitForExit();
                    int childCode = process.ExitCode;

                    // The host's receipt is the documented contract: it writes 0/2/3
                    // when the outcome is known, before it shows the result page.
                    int hostExit = ReadHostExit(Path.Combine(stateDir, "host-status.ini"));
                    if (hostExit < 0 && !silent)
                    {
                        // A cancelled install kills the installer, so its exit code
                        // is a termination status; give the receipt a moment.
                        hostExit = WaitForExitCode(stateDir, 3000);
                    }
                    if (hostExit >= 0) return hostExit;

                    // Silent updates never start the host and keep the installer's
                    // own exit code.
                    if (silent) return childCode;

                    // No receipt but the installer published done: the host was
                    // killed after a completed install.
                    if (HasPublishedDone(stateDir)) return 0;

                    // Interactive install that died before the host could report:
                    // a failure, not a user cancel.
                    return 3;
                }
            }
            catch (Exception error)
            {
                MessageBox.Show(
                    "安装程序无法准备临时目录。请检查当前用户目录的写入权限后重试。\n\n" +
                    "MusePi Setup could not prepare a private temporary directory. " +
                    "Check that your user profile is writable and try again.\n\n" + error.Message,
                    "MusePi 安装程序",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                return 1;
            }
            finally
            {
                if (workDir != null) CleanUp(workDir);
            }
        }

        private static int SelfTest()
        {
            Require(QuoteArgument("/S") == "/S", "silent flag");
            Require(QuoteArgument("--updated") == "--updated", "update flag");
            Require(QuoteArgument("C:\\A B\\setup.exe") == "\"C:\\A B\\setup.exe\"", "space quoting");
            Require(QuoteArgument("C:\\A B\\") == "\"C:\\A B\\\\\"", "trailing slash quoting");

            string statusFile = Path.Combine(
                Path.GetTempPath(), "musepi-bootstrap-self-test-" + Guid.NewGuid().ToString("N") + ".ini");
            try
            {
                Require(ReadHostExit(statusFile) == -1, "missing host status is unknown");
                File.WriteAllText(statusFile, "exit=2\r\n");
                Require(ReadHostExit(statusFile) == 2, "cancel is read back");
                File.WriteAllText(statusFile, "garbage\r\n");
                Require(ReadHostExit(statusFile) == -1, "garbage host status is unknown");
            }
            finally
            {
                try { File.Delete(statusFile); }
                catch (Exception) { }
            }

            Console.WriteLine("installer bootstrap self-test: PASS");
            return 0;
        }

        /// <summary>OTA updates pass /S (or --updated); they never start the host.</summary>
        private static bool IsSilentRun(string[] args)
        {
            foreach (string arg in args)
            {
                if (arg == "/S" || arg == "/s") return true;
                if (arg.StartsWith("--updated", StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        /// <summary>The installer's phase file, install-status.ini.</summary>
        private static bool HasPublishedDone(string stateDir)
        {
            try
            {
                string file = Path.Combine(stateDir, "install-status.ini");
                if (!File.Exists(file)) return false;
                foreach (string line in File.ReadAllLines(file))
                {
                    if (line.Trim().Equals("phase=done", StringComparison.OrdinalIgnoreCase)) return true;
                }
            }
            catch (Exception) { }
            return false;
        }

        private static int WaitForExitCode(string stateDir, int timeoutMs)
        {
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
            while (true)
            {
                int receipt = ReadHostExit(Path.Combine(stateDir, "host-status.ini"));
                if (receipt >= 0) return receipt;
                if (DateTime.UtcNow >= deadline) return -1;
                Thread.Sleep(150);
            }
        }

        /// <summary>
        /// Remove the private run directory once nothing is running from it.
        ///
        /// On cancel/failure the installer has already exited while the host is
        /// still showing the result page FROM this directory; deleting it then
        /// would fail on the running exe and let Windows remove the UI assets under
        /// the live page. So the first attempt is the fast path (success), and a
        /// refusal is followed by waiting for the host to close.
        /// </summary>
        private static void CleanUp(string workDir)
        {
            try { Directory.Delete(workDir, true); return; }
            catch (Exception) { }

            DateTime deadline = DateTime.UtcNow.AddMinutes(10);
            while (DateTime.UtcNow < deadline)
            {
                if (!HostStillRunning(workDir)) break;
                Thread.Sleep(500);
            }
            try { Directory.Delete(workDir, true); }
            catch (Exception) { }
        }

        private static bool HostStillRunning(string workDir)
        {
            try
            {
                foreach (Process process in Process.GetProcessesByName("MusePiInstallerHost"))
                {
                    using (process)
                    {
                        string path = null;
                        try { path = process.MainModule == null ? null : process.MainModule.FileName; }
                        catch (Exception) { }
                        if (path != null && path.StartsWith(workDir, StringComparison.OrdinalIgnoreCase)) return true;
                    }
                }
            }
            catch (Exception) { }
            return false;
        }

        /// <summary>Host receipt written by MusePiInstallerHost.exe; -1 when absent.</summary>
        private static int ReadHostExit(string path)
        {
            try
            {
                if (!File.Exists(path)) return -1;
                foreach (string line in File.ReadAllLines(path))
                {
                    string trimmed = line.Trim();
                    if (!trimmed.StartsWith("exit=", StringComparison.Ordinal)) continue;
                    int value;
                    if (int.TryParse(trimmed.Substring("exit=".Length), NumberStyles.Integer,
                            CultureInfo.InvariantCulture, out value))
                    {
                        return value;
                    }
                }
            }
            catch (Exception)
            {
                // An unreadable receipt leaves the child's exit code in charge.
            }
            return -1;
        }

        private static void Require(bool condition, string name)
        {
            if (!condition) throw new InvalidOperationException("Self-test failed: " + name);
        }

        private static string JoinArguments(string[] args)
        {
            return string.Join(" ", Array.ConvertAll(args, QuoteArgument));
        }

        private static string QuoteArgument(string value)
        {
            if (value.Length == 0) return "\"\"";
            bool needsQuotes = false;
            foreach (char c in value)
            {
                if (char.IsWhiteSpace(c) || c == '"')
                {
                    needsQuotes = true;
                    break;
                }
            }
            if (!needsQuotes) return value;

            StringBuilder result = new StringBuilder("\"");
            int slashes = 0;
            foreach (char c in value)
            {
                if (c == '\\')
                {
                    slashes++;
                    continue;
                }
                if (c == '"')
                {
                    result.Append('\\', slashes * 2 + 1);
                    result.Append('"');
                    slashes = 0;
                    continue;
                }
                result.Append('\\', slashes);
                result.Append(c);
                slashes = 0;
            }
            result.Append('\\', slashes * 2);
            result.Append('"');
            return result.ToString();
        }
    }
}
