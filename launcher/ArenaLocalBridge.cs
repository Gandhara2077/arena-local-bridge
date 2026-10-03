// A hidden owner for the existing Node/web GUI. Never find or kill a PID by
// port or file: retained process/job handles own only children we created.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        bool stop = false, noBrowser = false, consoleErrors = false;
        string root = AppDomain.CurrentDomain.BaseDirectory;
        try
        {
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--stop") stop = true;
                else if (args[i] == "--no-browser") noBrowser = true;
                else if (args[i] == "--console-errors") consoleErrors = true;
                else if (args[i] == "--root" && i + 1 < args.Length) root = args[++i];
                else throw new ArgumentException("Unknown launcher option: " + args[i]);
            }
            root = Path.GetFullPath(root);
            if (root != Path.GetPathRoot(root)) root = root.TrimEnd(Path.DirectorySeparatorChar);
            string pipe = "ArenaLocalBridge-" + InstallId(root);
            using (var mutex = new Mutex(false, "Local\\" + pipe))
            {
                bool owned;
                try { owned = mutex.WaitOne(0); }
                catch (AbandonedMutexException) { owned = true; }
                if (!owned) return ContactOwner(pipe, stop ? "STOP" : noBrowser ? "CHECK" : "OPEN");
                try
                {
                    if (stop) return 0;
                    using (var launcher = new Launcher(root, pipe)) return launcher.Run(noBrowser);
                }
                finally { mutex.ReleaseMutex(); }
            }
        }
        catch (Exception error)
        {
            string message = error.Message + "\n\nLogs: " + Path.Combine(root, ".arena-gui", "bridge.log");
            if (consoleErrors)
            {
                // A GUI-subsystem executable has no console code page to set.
                // Write UTF-8 to an inherited stderr handle when invoked by CLI.
                using (var errors = new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false)))
                    errors.WriteLine(message);
            }
            else MessageBox.Show(message, "Arena Local Bridge", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    private static string InstallId(string root)
    {
        using (var hash = SHA256.Create())
            return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(root.ToLowerInvariant())))
                .Replace("-", "").Substring(0, 32);
    }

    private static int ContactOwner(string pipe, string command)
    {
        using (var client = new NamedPipeClientStream(".", pipe, PipeDirection.InOut))
        {
            try { client.Connect(5000); }
            catch (TimeoutException) { throw new IOException("An earlier launcher is still starting or closing. Retry in a few seconds."); }
            var writer = new StreamWriter(client, new UTF8Encoding(false)) { AutoFlush = true };
            var reader = new StreamReader(client, Encoding.UTF8);
            writer.WriteLine(command);
            string response = reader.ReadLine();
            if (response != "OK") throw new IOException(response == null ? "The earlier launcher closed. Retry." : response);
            return 0;
        }
    }
}

internal sealed class Launcher : IDisposable
{
    private readonly string root, pipe, instance = Guid.NewGuid().ToString("N");
    private readonly ManualResetEvent ready = new ManualResetEvent(false);
    private readonly ManualResetEvent controlFinished = new ManualResetEvent(false);
    private readonly object logLock = new object(), stopLock = new object();
    private volatile bool stopping, closing;
    private volatile string failure;
    private Process child;
    private OwnedJob job;
    private StreamWriter log;
    private string url;
    private int timeout;

    internal Launcher(string root, string pipe) { this.root = root; this.pipe = pipe; }

    internal int Run(bool noBrowser)
    {
        try
        {
            string script = Path.Combine(root, "bin", "gui-runtime.mjs");
            if (!File.Exists(script) || !File.Exists(Path.Combine(root, "src", "index.mjs")))
                throw new IOException("The application files are missing. Extract the complete portable ZIP before starting.");
            string node = Path.Combine(root, "runtime", "node.exe");
            if (!File.Exists(node)) node = Environment.GetEnvironmentVariable("ARENA_NODE_PATH") ?? "node";
            int port;
            string portSetting = Environment.GetEnvironmentVariable("PORT");
            if (String.IsNullOrEmpty(portSetting)) port = 20140;
            else if (!Int32.TryParse(portSetting, out port) || port < 1 || port > 65535)
                throw new ArgumentException("PORT must be a number between 1 and 65535.");
            url = "http://127.0.0.1:" + port + "/";
            timeout = 30000;
            string timeoutSetting = Environment.GetEnvironmentVariable("ARENA_LAUNCHER_TIMEOUT_MS");
            if (timeoutSetting != null && (!Int32.TryParse(timeoutSetting, out timeout) || timeout < 500 || timeout > 120000))
                throw new ArgumentException("ARENA_LAUNCHER_TIMEOUT_MS must be between 500 and 120000.");
            var start = new ProcessStartInfo(node, "\"" + script + "\"")
            {
                WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
            };
            string data = Path.Combine(root, ".arena-gui");
            start.EnvironmentVariables["DATA_DIR"] = data;
            start.EnvironmentVariables["HOST"] = "127.0.0.1";
            start.EnvironmentVariables["PORT"] = port.ToString();
            start.EnvironmentVariables["ARENA_HEADED"] = "1";
            start.EnvironmentVariables["ARENA_LAUNCHER_INSTANCE"] = instance;
            if (String.IsNullOrEmpty(start.EnvironmentVariables["ARENA_AGENT_BRIDGE_KEY"]))
                start.EnvironmentVariables["ARENA_AGENT_BRIDGE_KEY"] = "local-dev-key";
            ReadPathSetting(start, "archive-dir.txt", "ARENA_ARCHIVE_DIR");
            ReadPathSetting(start, "mcp-workspace.txt", "ARENA_MCP_WORKSPACE");
            try
            {
                var probe = new TcpListener(IPAddress.Loopback, port);
                try { probe.Start(); }
                finally { probe.Stop(); }
            }
            catch (SocketException) { throw new IOException("Port " + port + " is already in use. Close that application yourself or choose a different PORT; no process was stopped."); }
            Directory.CreateDirectory(data);
            log = new StreamWriter(new FileStream(Path.Combine(data, "bridge.log"), FileMode.Append, FileAccess.Write, FileShare.ReadWrite), new UTF8Encoding(false)) { AutoFlush = true };
            job = new OwnedJob();
            child = new Process { StartInfo = start };
            child.OutputDataReceived += LogLine;
            child.ErrorDataReceived += LogLine;
            if (!child.Start()) throw new IOException("The Node runtime could not be started.");
            job.Add(child);
            child.BeginOutputReadLine();
            child.BeginErrorReadLine();
            var controls = new Thread(ServeControls) { IsBackground = true };
            controls.Start();
            child.StandardInput.WriteLine("START");
            child.StandardInput.Flush();

            var clock = Stopwatch.StartNew();
            while (clock.ElapsedMilliseconds < timeout && !stopping)
            {
                if (child.HasExited) throw new IOException("The bridge exited before startup (exit " + child.ExitCode + "). Review bridge.log for the cause.");
                if (Healthy())
                {
                    ready.Set();
                    if (!noBrowser) OpenBrowser();
                    while (!child.WaitForExit(250)) { }
                    if (!stopping) throw new IOException("The bridge exited unexpectedly (exit " + child.ExitCode + "). Review bridge.log for the cause.");
                    controlFinished.WaitOne(15000);
                    return 0;
                }
                child.WaitForExit(100);
            }
            if (stopping) { controlFinished.WaitOne(15000); return 0; }
            throw new IOException("Startup timed out waiting for this bridge's /health response. Review bridge.log and verify that Chrome or Edge is installed.");
        }
        catch (Exception error)
        {
            failure = error.Message;
            ready.Set();
            throw;
        }
    }

    private void ReadPathSetting(ProcessStartInfo start, string file, string variable)
    {
        string full = Path.Combine(root, file);
        if (!File.Exists(full)) return;
        string value = File.ReadAllText(full, new UTF8Encoding(false, true)).Trim().TrimStart('\uFEFF');
        if (value.IndexOfAny(new[] { '\r', '\n', '\0' }) >= 0)
            throw new IOException(file + " must contain a single UTF-8 path on one line.");
        start.EnvironmentVariables[variable] = value;
    }

    private bool Healthy()
    {
        try
        {
            var request = (HttpWebRequest)WebRequest.Create(url + "health");
            request.Proxy = null;
            request.Timeout = 500;
            request.ReadWriteTimeout = 500;
            request.AllowAutoRedirect = false;
            using (var response = (HttpWebResponse)request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
            {
                if (response.StatusCode != HttpStatusCode.OK || response.ContentLength > 1048576) return false;
                var payload = new JavaScriptSerializer { MaxJsonLength = 1048576 }.Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                object service, marker, ok;
                return payload != null && payload.TryGetValue("service", out service) && Equals(service, "arena-bridge")
                    && payload.TryGetValue("launcherInstance", out marker) && Equals(marker, instance)
                    && payload.TryGetValue("ok", out ok) && Equals(ok, true);
            }
        }
        catch (WebException) { return false; }
        catch (IOException) { return false; }
        catch (ArgumentException) { return false; }
        catch (InvalidOperationException) { return false; }
    }

    private void ServeControls()
    {
        var security = new PipeSecurity();
        security.SetAccessRuleProtection(true, false);
        security.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.FullControl, AccessControlType.Allow));
        while (!closing)
        {
            try
            {
                bool stop;
                using (var server = new NamedPipeServerStream(pipe, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.None, 4096, 4096, security))
                {
                    server.WaitForConnection();
                    var reader = new StreamReader(server, Encoding.UTF8);
                    var writer = new StreamWriter(server, new UTF8Encoding(false)) { AutoFlush = true };
                    string command = reader.ReadLine();
                    stop = command == "STOP";
                    if (stop)
                    {
                        stopping = true;
                        try { StopChild(); writer.WriteLine("OK"); }
                        catch (Exception error) { writer.WriteLine("Stop failed: " + error.Message); }
                        finally { controlFinished.Set(); }
                    }
                    else if (command == "OPEN" || command == "CHECK")
                    {
                        if (!ready.WaitOne(timeout + 2000)) writer.WriteLine("The earlier launcher is still waiting for /health. Review bridge.log.");
                        else if (failure != null || stopping) writer.WriteLine(failure ?? "The bridge is stopping. Retry after it closes.");
                        else
                        {
                            try
                            {
                                if (command == "OPEN") OpenBrowser();
                                writer.WriteLine("OK");
                            }
                            catch (IOException error) { writer.WriteLine(error.Message); }
                        }
                    }
                    else writer.WriteLine("Unknown launcher control command.");
                }
            }
            catch (IOException) { if (closing) return; }
            catch (Exception error) { WriteLog("Launcher control: " + error.Message); }
        }
    }

    private void OpenBrowser()
    {
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
        catch (Exception) { throw new IOException("The browser could not open. Set a default browser in Windows and launch Arena Local Bridge again. GUI address: " + url); }
    }

    private void LogLine(object sender, DataReceivedEventArgs args) { if (args.Data != null) WriteLog(args.Data); }
    private void WriteLog(string value)
    {
        lock (logLock) { if (log != null) log.WriteLine(value); }
    }

    private void StopChild()
    {
        lock (stopLock)
        {
            if (child == null) return;
            try
            {
                if (!child.HasExited)
                {
                    child.StandardInput.WriteLine("STOP");
                    child.StandardInput.Flush();
                    child.WaitForExit(10000);
                }
                // Closing the root process need not close browser/runtime
                // grandchildren. The job contains only our retained children.
                if (job != null) job.Terminate();
            }
            catch (InvalidOperationException) { }
            catch (IOException) { if (job != null) job.Terminate(); }
        }
    }

    public void Dispose()
    {
        closing = true;
        stopping = true;
        ready.Set();
        StopChild();
        if (job != null) { job.Dispose(); job = null; }
        if (child != null) child.Dispose();
        lock (logLock) { if (log != null) { log.Dispose(); log = null; } }
    }
}

internal sealed class OwnedJob : IDisposable
{
    private IntPtr handle;
    internal OwnedJob()
    {
        handle = CreateJobObject(IntPtr.Zero, null);
        if (handle == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
        var limits = new ExtendedLimits();
        limits.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        int size = Marshal.SizeOf(limits);
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limits, buffer, false);
            if (!SetInformationJobObject(handle, 9, buffer, (uint)size))
                throw new System.ComponentModel.Win32Exception();
        }
        catch { Dispose(); throw; }
        finally { Marshal.FreeHGlobal(buffer); }
    }
    internal void Add(Process process)
    {
        if (!AssignProcessToJobObject(handle, process.Handle))
        {
            // The child is still waiting for START, so it has no descendants.
            int code = Marshal.GetLastWin32Error();
            TerminateProcess(process.Handle, 1);
            throw new System.ComponentModel.Win32Exception(code, "Could not own the Node process safely.");
        }
    }
    internal void Terminate()
    {
        if (handle != IntPtr.Zero && !TerminateJobObject(handle, 1)) throw new System.ComponentModel.Win32Exception();
    }
    public void Dispose() { if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; } }
    [StructLayout(LayoutKind.Sequential)] private struct BasicLimits
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] private struct IoCounters
    { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimits
    {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
}
