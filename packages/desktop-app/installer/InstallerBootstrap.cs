using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
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

                ProcessStartInfo start = new ProcessStartInfo();
                start.FileName = payload;
                start.WorkingDirectory = workDir;
                start.UseShellExecute = false;
                start.CreateNoWindow = true;
                start.Arguments = JoinArguments(args);
                start.EnvironmentVariables["TEMP"] = workDir;
                start.EnvironmentVariables["TMP"] = workDir;
                using (Process process = Process.Start(start))
                {
                    process.WaitForExit();
                    return process.ExitCode;
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
                if (workDir != null)
                {
                    try { Directory.Delete(workDir, true); }
                    catch { }
                }
            }
        }

        private static int SelfTest()
        {
            Require(QuoteArgument("/S") == "/S", "silent flag");
            Require(QuoteArgument("--updated") == "--updated", "update flag");
            Require(QuoteArgument("C:\\A B\\setup.exe") == "\"C:\\A B\\setup.exe\"", "space quoting");
            Require(QuoteArgument("C:\\A B\\") == "\"C:\\A B\\\\\"", "trailing slash quoting");
            Console.WriteLine("installer bootstrap self-test: PASS");
            return 0;
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
