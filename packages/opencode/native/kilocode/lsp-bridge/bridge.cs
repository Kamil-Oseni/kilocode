using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;

// Source-only draft. This program is not wired into production or accepted yet.
namespace Raya.Lsp;

internal static class Native
{
    internal const uint Infinite = 0xffffffff;
    internal const uint Broken = 109;
    internal const uint Aborted = 995;
    internal const uint Missing = 1168;
    internal const uint Extended = 0x00080000;
    internal const uint Suspended = 4;
    internal const uint Unicode = 0x400;
    internal static readonly IntPtr Invalid = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential)] internal struct Security
    { internal int Size; internal IntPtr Descriptor; [MarshalAs(UnmanagedType.Bool)] internal bool Inherit; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] internal struct Startup
    {
        internal int Size; internal IntPtr Reserved; internal IntPtr Desktop; internal IntPtr Title;
        internal uint X, Y, Width, Height, XCount, YCount, Fill, Flags;
        internal ushort Show, ReservedSize; internal IntPtr ReservedBytes, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] internal struct ExtendedStartup
    { internal Startup Base; internal IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] internal struct Process
    { internal IntPtr Handle, Thread; internal uint Pid, Tid; }
    [StructLayout(LayoutKind.Sequential)] internal struct Time
    { internal uint Low, High; internal ulong Value => ((ulong)High << 32) | Low; }
    [StructLayout(LayoutKind.Sequential)] internal struct Accounting
    { internal long User, Kernel, PeriodUser, PeriodKernel; internal uint Faults, Total, Active, Terminated; }
    [StructLayout(LayoutKind.Sequential)] internal struct Information
    {
        internal uint Attributes; internal Time Creation, Access, Write; internal uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] internal delegate uint Entry(IntPtr value);

    [DllImport("kernel32.dll", SetLastError = true)] internal static extern IntPtr GetStdHandle(int id);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint GetFileType(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref Security security, uint size);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool ReadFile(IntPtr handle, byte[] bytes, uint size, out uint read, IntPtr overlap);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool WriteFile(IntPtr handle, byte[] bytes, uint size, out uint written, IntPtr overlap);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern IntPtr CreateJobObjectW(IntPtr security, string? name);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting value, uint size, IntPtr length);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr key, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] internal static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CreateProcessW(string application, StringBuilder command, IntPtr process, IntPtr thread, bool inherit, uint flags, IntPtr environment, string directory, ref ExtendedStartup startup, out Process result);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetProcessTimes(IntPtr process, out Time creation, out Time exit, out Time kernel, out Time user);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder path, ref uint size);
    [DllImport("kernel32.dll", SetLastError = true)] internal static extern IntPtr CreateThread(IntPtr security, UIntPtr stack, Entry entry, IntPtr value, uint flags, out uint id);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool CancelSynchronousIo(IntPtr thread);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security, uint mode, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] internal static extern bool GetFileInformationByHandle(IntPtr file, out Information value);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern uint GetFinalPathNameByHandleW(IntPtr file, StringBuilder path, uint size, uint flags);
}

internal sealed record Envelope(string Token, string Target, string Sha256, string Cwd, string[] Args, SortedDictionary<string, string> Env);

internal static class Frame
{
    internal static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);

    internal static void Exact(IntPtr input, byte[] bytes)
    {
        var offset = 0;
        while (offset < bytes.Length)
        {
            var block = new byte[bytes.Length - offset];
            if (!Native.ReadFile(input, block, (uint)block.Length, out var count, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error(), "startup read");
            if (count == 0) throw new EndOfStreamException("startup frame incomplete");
            Buffer.BlockCopy(block, 0, bytes, offset, (int)count);
            offset += (int)count;
        }
    }

    internal static Envelope Read(IntPtr input)
    {
        var prefix = new byte[4];
        Exact(input, prefix);
        var length = (uint)prefix[0] | ((uint)prefix[1] << 8) | ((uint)prefix[2] << 16) | ((uint)prefix[3] << 24);
        if (length == 0 || length > 65536) throw new InvalidDataException("startup frame bound");
        var bytes = new byte[(int)length];
        Exact(input, bytes);
        using var doc = JsonDocument.Parse(Utf8.GetString(bytes), new JsonDocumentOptions { MaxDepth = 16, AllowTrailingCommas = false, CommentHandling = JsonCommentHandling.Disallow });
        var nodes = 0;
        Unique(doc.RootElement, ref nodes);
        var root = doc.RootElement;
        Keys(root, "version", "token", "target", "sha256", "cwd", "args", "env");
        if (root.GetProperty("version").GetRawText() != "1") throw new InvalidDataException("startup version");
        var token = Text(root, "token", 64);
        if (token.Length != 32 || token.Any(c => !Uri.IsHexDigit(c))) throw new InvalidDataException("startup token");
        var digest = Text(root, "sha256", 64);
        if (digest.Length != 64 || digest.Any(c => !Uri.IsHexDigit(c))) throw new InvalidDataException("startup digest");
        var target = PathValue(Text(root, "target", 32760));
        var cwd = PathValue(Text(root, "cwd", 32760));
        var args = root.GetProperty("args");
        if (args.ValueKind != JsonValueKind.Array || args.GetArrayLength() > 128) throw new InvalidDataException("startup argv");
        var values = args.EnumerateArray().Select(value => String(value, 8192)).ToArray();
        var env = root.GetProperty("env");
        if (env.ValueKind != JsonValueKind.Object) throw new InvalidDataException("startup environment");
        var map = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in env.EnumerateObject())
        {
            if (map.Count >= 128 || item.Name.Length == 0 || item.Name.Length > 128 || item.Name.Contains('=') || item.Name.Contains('\0')) throw new InvalidDataException("startup environment key");
            map.Add(item.Name, String(item.Value, 8192));
        }
        if (map.Sum(row => (row.Key.Length + row.Value.Length + 2) * 2) > 65532) throw new InvalidDataException("startup environment bound");
        return new Envelope(token, target, digest.ToLowerInvariant(), cwd, values, map);
    }

    internal static string PathValue(string value)
    {
        if (!Path.IsPathFullyQualified(value) || value.StartsWith("\\\\", StringComparison.Ordinal) || value.Contains('\0') || value.Length < 3 || value[1] != ':') throw new InvalidDataException("local absolute path required");
        var path = Path.GetFullPath(value);
        if (!string.Equals(path.TrimEnd('\\'), value.Replace('/', '\\').TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("canonical path required");
        return path;
    }

    private static string Text(JsonElement root, string key, int maximum) => String(root.GetProperty(key), maximum);
    private static string String(JsonElement value, int maximum)
    {
        if (value.ValueKind != JsonValueKind.String) throw new InvalidDataException("string required");
        var text = value.GetString()!;
        if (text.Length > maximum || text.Contains('\0')) throw new InvalidDataException("string bound");
        return text;
    }
    private static void Keys(JsonElement value, params string[] keys)
    {
        if (value.ValueKind != JsonValueKind.Object || !value.EnumerateObject().Select(row => row.Name).OrderBy(row => row, StringComparer.Ordinal).SequenceEqual(keys.OrderBy(row => row, StringComparer.Ordinal))) throw new InvalidDataException("startup key set");
    }
    private static void Unique(JsonElement value, ref int nodes)
    {
        if (++nodes > 4096) throw new InvalidDataException("startup node bound");
        if (value.ValueKind == JsonValueKind.Object)
        {
            var keys = new HashSet<string>(StringComparer.Ordinal);
            foreach (var row in value.EnumerateObject())
            {
                if (!keys.Add(row.Name)) throw new InvalidDataException("duplicate startup key");
                Unique(row.Value, ref nodes);
            }
        }
        if (value.ValueKind == JsonValueKind.Array) foreach (var row in value.EnumerateArray()) Unique(row, ref nodes);
    }
}

// These handles are retained until the original thread completes, including failures.
internal sealed class Pump
{
    private readonly IntPtr read;
    private readonly IntPtr write;
    private readonly bool input;
    private readonly Action<string, int> failure;
    private readonly Native.Entry entry;
    private int terminal;
    internal IntPtr Thread { get; private set; }

    internal Pump(IntPtr read, IntPtr write, bool input, Action<string, int> failure)
    {
        this.read = read;
        this.write = write;
        this.input = input;
        this.failure = failure;
        entry = Run;
    }
    internal void Start()
    {
        Thread = Native.CreateThread(IntPtr.Zero, UIntPtr.Zero, entry, IntPtr.Zero, 0, out _);
        if (Thread == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "pump thread create");
    }
    internal void Stop()
    {
        if (!input || Thread == IntPtr.Zero) return;
        Interlocked.Exchange(ref terminal, 1);
        if (!Native.CancelSynchronousIo(Thread))
        {
            var error = Marshal.GetLastWin32Error();
            if (error != Native.Missing) failure("input cancellation", error);
        }
        // ERROR_NOT_FOUND is not settlement: Join still waits on this exact handle.
    }
    internal void Join()
    {
        if (Thread == IntPtr.Zero) return;
        // Repeat only terminal input cancellation to cover a read racing the first
        // ERROR_NOT_FOUND. Output readers are never canceled.
        if (input && Volatile.Read(ref terminal) != 0)
        {
            while (true)
            {
                var status = Native.WaitForSingleObject(Thread, 50);
                if (status == 0) break;
                if (status != 258) throw new Win32Exception(Marshal.GetLastWin32Error(), "input join");
                Stop();
            }
        }
        else if (Native.WaitForSingleObject(Thread, Native.Infinite) != 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "pump join");
        GC.KeepAlive(entry);
    }
    internal void Release()
    {
        if (Thread == IntPtr.Zero) return;
        if (!Native.CloseHandle(Thread)) throw new Win32Exception(Marshal.GetLastWin32Error(), "pump handle close");
        Thread = IntPtr.Zero;
    }
    private uint Run(IntPtr unused)
    {
        var forward = true;
        try
        {
            var buffer = new byte[65536];
            while (!input || Volatile.Read(ref terminal) == 0)
            {
                if (!Native.ReadFile(read, buffer, (uint)buffer.Length, out var count, IntPtr.Zero))
                {
                    var error = Marshal.GetLastWin32Error();
                    if (error != Native.Broken && !(input && Volatile.Read(ref terminal) != 0 && error == Native.Aborted)) failure(input ? "input read" : "output read", error);
                    break;
                }
                if (count == 0 || (input && Volatile.Read(ref terminal) != 0)) break;
                var offset = 0;
                while (forward && offset < count && (!input || Volatile.Read(ref terminal) == 0))
                {
                    var block = new byte[(int)count - offset];
                    Buffer.BlockCopy(buffer, offset, block, 0, block.Length);
                    if (!Native.WriteFile(write, block, (uint)block.Length, out var written, IntPtr.Zero))
                    {
                        var error = Marshal.GetLastWin32Error();
                        if (!(input && error == Native.Broken) && !(input && Volatile.Read(ref terminal) != 0 && error == Native.Aborted)) failure(input ? "input write" : "output forward", error);
                        forward = false;
                        if (input) return 0;
                        break;
                    }
                    if (written == 0) { failure("zero-byte forwarding", 0); forward = false; if (input) return 0; break; }
                    offset += (int)written;
                }
                // Failed output sinks never stop draining the original native pipe.
            }
        }
        catch (Exception error) { failure(input ? "input exception" : "output exception", error.HResult); }
        return 0;
    }
}

internal sealed class Keeper
{
    private readonly List<(string Phase, int Code)> failures = new List<(string, int)>();
    private readonly List<IntPtr> handles = new List<IntPtr>();
    private readonly List<IntPtr> ancestry = new List<IntPtr>();
    private readonly List<IntPtr> ends = new List<IntPtr>();
    private readonly List<Pump> pumps = new List<Pump>();
    private IntPtr job;
    private Native.Process process;
    private Pump? input;
    private IntPtr writer;
    private bool created;
    private bool resumed;
    private uint code;
    private ulong birth;
    private bool zero;
    private string image = "";

    internal void Failure(string phase, int code) { lock (failures) { if (failures.Count < 64) failures.Add((phase, code)); } }
    private IntPtr Retain(IntPtr handle)
    {
        if (handle == IntPtr.Zero || handle == Native.Invalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "native handle");
        handles.Add(handle);
        return handle;
    }
    private void Drop(IntPtr handle)
    {
        if (!handles.Contains(handle)) return;
        if (!Native.CloseHandle(handle)) { Failure("handle close", Marshal.GetLastWin32Error()); return; }
        handles.Remove(handle);
    }
    private (IntPtr Read, IntPtr Write) Pipe()
    {
        var security = new Native.Security { Size = Marshal.SizeOf<Native.Security>(), Inherit = true };
        if (!Native.CreatePipe(out var read, out var write, ref security, 0)) throw new Win32Exception(Marshal.GetLastWin32Error(), "pipe create");
        Retain(read); Retain(write);
        return (read, write);
    }
    private static string Quote(string value)
    {
        var output = new StringBuilder("\"");
        var slashes = 0;
        foreach (var c in value)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') output.Append('\\', slashes * 2 + 1).Append('"');
            else output.Append('\\', slashes).Append(c);
            slashes = 0;
        }
        return output.Append('\\', slashes * 2).Append('"').ToString();
    }
    internal void Pin(string path, bool directory)
    {
        var list = new Stack<string>();
        for (var current = directory ? path : Path.GetDirectoryName(path); current != null; current = Path.GetDirectoryName(current.TrimEnd('\\')))
        {
            list.Push(current);
            if (current == Path.GetPathRoot(current)) break;
        }
        if (!directory) list.EnqueuePath(path);
        foreach (var entry in list)
        {
            var leaf = string.Equals(entry, path, StringComparison.OrdinalIgnoreCase) && !directory;
            var handle = Retain(Native.CreateFileW(entry, 0x80, 1, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero));
            if (!Native.GetFileInformationByHandle(handle, out var info)) throw new Win32Exception(Marshal.GetLastWin32Error(), "path identity");
            if ((info.Attributes & 0x400) != 0 || ((info.Attributes & 0x10) != 0) == leaf || (leaf && info.Links != 1)) throw new InvalidDataException("ordinary path required");
            var canonical = new StringBuilder(32768);
            var size = Native.GetFinalPathNameByHandleW(handle, canonical, (uint)canonical.Capacity, 0);
            if (size == 0 || size >= canonical.Capacity || !string.Equals(canonical.ToString().Replace("\\\\?\\", "").TrimEnd('\\'), entry.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("path alias refused");
            ancestry.Add(handle);
        }
    }
    internal void Start(Envelope value, string control)
    {
        Pin(value.Cwd, true);
        Pin(control, true);
        Pin(value.Target, false);
        using (var file = new FileStream(value.Target, FileMode.Open, FileAccess.Read, FileShare.Read))
            if (Convert.ToHexString(SHA256.HashData(file)).ToLowerInvariant() != value.Sha256) throw new InvalidDataException("target digest mismatch");
        job = Retain(Native.CreateJobObjectW(IntPtr.Zero, null));
        var stdin = Pipe(); var stdout = Pipe(); var stderr = Pipe();
        ends.Add(stdin.Read); ends.Add(stdout.Write); ends.Add(stderr.Write);
        writer = stdin.Write;
        foreach (var handle in new[] { stdin.Write, stdout.Read, stderr.Read })
            if (!Native.SetHandleInformation(handle, 1, 0)) throw new Win32Exception(Marshal.GetLastWin32Error(), "pipe inheritance");
        input = new Pump(Native.GetStdHandle(-10), stdin.Write, true, Failure);
        pumps.Add(input);
        pumps.Add(new Pump(stdout.Read, Native.GetStdHandle(-11), false, Failure));
        pumps.Add(new Pump(stderr.Read, Native.GetStdHandle(-12), false, Failure));
        // All pumps exist before child creation; any pre-create failure retires them.
        foreach (var pump in pumps) pump.Start();
        var size = IntPtr.Zero;
        Native.InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
        var attributes = Marshal.AllocHGlobal(size);
        var inherited = Marshal.AllocHGlobal(IntPtr.Size * 3);
        var jobs = Marshal.AllocHGlobal(IntPtr.Size);
        var environment = Marshal.StringToHGlobalUni(string.Join("\0", value.Env.Select(row => row.Key + "=" + row.Value)) + "\0\0");
        var initialized = false;
        try
        {
            if (!Native.InitializeProcThreadAttributeList(attributes, 2, 0, ref size)) throw new Win32Exception(Marshal.GetLastWin32Error(), "attribute create");
            initialized = true;
            Marshal.WriteIntPtr(inherited, 0, stdin.Read); Marshal.WriteIntPtr(inherited, IntPtr.Size, stdout.Write); Marshal.WriteIntPtr(inherited, IntPtr.Size * 2, stderr.Write);
            Marshal.WriteIntPtr(jobs, job);
            if (!Native.UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x00020002), inherited, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero) || !Native.UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x0002000D), jobs, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error(), "creation attributes");
            var startup = new Native.ExtendedStartup { Base = new Native.Startup { Size = Marshal.SizeOf<Native.ExtendedStartup>(), Flags = 0x100, Input = stdin.Read, Output = stdout.Write, Error = stderr.Write }, Attributes = attributes };
            var command = string.Join(" ", new[] { value.Target }.Concat(value.Args).Select(Quote));
            if (command.Length > 32766) throw new InvalidDataException("command bound");
            if (!Native.CreateProcessW(value.Target, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, true, Native.Extended | Native.Suspended | Native.Unicode, environment, value.Cwd, ref startup, out process)) throw new Win32Exception(Marshal.GetLastWin32Error(), "target create");
            // No throwing operation precedes ownership installation after CreateProcess.
            created = true;
            handles.Add(process.Handle); handles.Add(process.Thread);
            Drop(stdin.Read); Drop(stdout.Write); Drop(stderr.Write);
            if (!Native.GetProcessTimes(process.Handle, out var time, out _, out _, out _)) throw new Win32Exception(Marshal.GetLastWin32Error(), "target birth");
            birth = time.Value;
            var actual = new StringBuilder(32768);
            var capacity = (uint)actual.Capacity;
            if (!Native.QueryFullProcessImageNameW(process.Handle, 0, actual, ref capacity)) throw new Win32Exception(Marshal.GetLastWin32Error(), "target image");
            image = Frame.PathValue(actual.ToString());
            if (!string.Equals(image, value.Target, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("created image mismatch");
            Resume();
            Publish(control, "launch.json", new { format = "raya.lsp.bridge.launch", version = 1, token = value.Token, pid = process.Pid, birth = birth.ToString(), bridge = Environment.ProcessId, executable = image, digest = value.Sha256, creationJob = true, fullMembersObserved = false });
        }
        finally
        {
            if (initialized) Native.DeleteProcThreadAttributeList(attributes);
            Marshal.FreeHGlobal(attributes); Marshal.FreeHGlobal(inherited); Marshal.FreeHGlobal(jobs); Marshal.FreeHGlobal(environment);
        }
    }
    private void Resume()
    {
        if (!created || resumed) return;
        if (Native.ResumeThread(process.Thread) == uint.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error(), "target resume");
        resumed = true;
    }
    internal void Retire()
    {
        if (created)
        {
            // Post-create bootstrap failures cannot release a suspended or live family.
            while (!resumed)
            {
                try { Resume(); } catch (Exception error) { Failure("resume keeper", error.HResult); Thread.Sleep(100); }
            }
            if (Native.WaitForSingleObject(process.Handle, Native.Infinite) != 0) throw new Win32Exception(Marshal.GetLastWin32Error(), "original root wait");
            input?.Stop();
            if (!Native.GetExitCodeProcess(process.Handle, out code)) Failure("original exit code", Marshal.GetLastWin32Error());
            if (code != 0) Failure("target nonzero", unchecked((int)code));
        }
        if (!created)
        {
            input?.Stop();
            // No child exists: close only our child ends to release original readers.
            foreach (var handle in ends) Drop(handle);
        }
        input?.Join();
        Drop(writer);
        if (created)
        {
            while (!zero)
            {
                if (!Native.QueryInformationJobObject(job, 1, out var account, (uint)Marshal.SizeOf<Native.Accounting>(), IntPtr.Zero)) { Failure("job query", Marshal.GetLastWin32Error()); Thread.Sleep(100); continue; }
                zero = account.Active == 0;
                if (!zero) Thread.Sleep(50);
            }
        }
        foreach (var pump in pumps) pump.Join();
        foreach (var pump in pumps) pump.Release();
        foreach (var handle in handles.Where(handle => !ancestry.Contains(handle)).ToArray()) Drop(handle);
        // Handle close failures keep an unresolved keeper instead of claiming closure.
        while (handles.Any(handle => !ancestry.Contains(handle))) { Thread.Sleep(100); foreach (var handle in handles.Where(handle => !ancestry.Contains(handle)).ToArray()) Drop(handle); }
    }
    internal void Release()
    {
        foreach (var handle in ancestry) Drop(handle);
        while (handles.Count != 0) { Thread.Sleep(100); foreach (var handle in handles.ToArray()) Drop(handle); }
    }
    internal object Result(Envelope value) => new { format = "raya.lsp.bridge.result", version = 1, token = value.Token, pid = process.Pid, birth = birth.ToString(), executable = image, digest = value.Sha256, created, rootExit = created ? (uint?)code : null, jobZero = zero, inputJoined = true, outputJoined = true, forced = false, fullMembersObserved = false, failures = failures.Select(row => new { phase = row.Phase, code = row.Code }).ToArray() };
    internal bool Failed { get { lock (failures) return failures.Count != 0; } }
    internal static void Publish(string directory, string name, object value)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(value);
        if (bytes.Length > 16384) throw new InvalidDataException("control bound");
        using var file = new FileStream(Path.Combine(directory, name), FileMode.CreateNew, FileAccess.Write, FileShare.Read);
        file.Write(bytes); file.Flush(true);
    }
}

internal static class Paths
{
    internal static void EnqueuePath(this Stack<string> list, string path)
    {
        // Preserve root-to-leaf iteration while adding the executable after ancestry.
        var parents = list.ToArray(); list.Clear(); list.Push(path);
        for (var index = parents.Length - 1; index >= 0; index--) list.Push(parents[index]);
    }
}

internal static class Program
{
    internal static int Main(string[] args)
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(10) || args.Length != 2 || args[0] != "--control") return 2;
        Envelope? value = null;
        var keeper = new Keeper();
        var control = "";
        try
        {
            control = Frame.PathValue(args[1]);
            foreach (var id in new[] { -10, -11, -12 })
                if (Native.GetFileType(Native.GetStdHandle(id)) != 3) throw new InvalidDataException("three private pipe handles required");
            value = Frame.Read(Native.GetStdHandle(-10));
            keeper.Start(value, control);
        }
        catch (Exception error) { keeper.Failure("bootstrap", error.HResult); }
        // Original joins are deliberately unbounded; caller deadlines only observe.
        try { keeper.Retire(); }
        catch (Exception error)
        {
            keeper.Failure("retirement", error.HResult);
            // Do not exit/dispose a potentially live original owner on failed joins.
            while (true) Thread.Sleep(1000);
        }
        if (value != null)
        {
            try { Keeper.Publish(control, "result.json", keeper.Result(value)); }
            catch (Exception error) { keeper.Failure("result publication", error.HResult); }
        }
        keeper.Release();
        return keeper.Failed ? 1 : 0;
    }
}
