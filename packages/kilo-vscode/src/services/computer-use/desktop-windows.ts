import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomBytes } from "node:crypto"
import {
  CAPTURE,
  type DesktopAction,
  type DesktopControl,
  type DesktopDriver,
  type DesktopDispatchTarget,
  type DesktopFrame,
  type DesktopSemantics,
  type DesktopWindow,
} from "./desktop-session"
import { DesktopCaptureWorker, type CapturedScene } from "./desktop-capture-worker"
import { NativeCaptureHost } from "./desktop-native-host"

const native = String.raw`
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

public sealed class RayaBoundedStream : MemoryStream {
  private readonly long limit;

  public RayaBoundedStream(long limit) {
    if (limit <= 0) throw new ArgumentOutOfRangeException("limit");
    this.limit = limit;
  }

  public override void SetLength(long value) {
    if (value > limit) throw new InvalidOperationException("Desktop capture exceeds the encoded image limit");
    base.SetLength(value);
  }

  public override void Write(byte[] buffer, int offset, int count) {
    if (count < 0 || Position > limit - count)
      throw new InvalidOperationException("Desktop capture exceeds the encoded image limit");
    base.Write(buffer, offset, count);
  }

  public override void WriteByte(byte value) {
    if (Position >= limit) throw new InvalidOperationException("Desktop capture exceeds the encoded image limit");
    base.WriteByte(value);
  }
}

public static class RayaDesktopNative {
  private const string InstanceProperty = "RayaDesktopWindowInstanceV1_74CB301759F7435B9AD54D283319FF5B";
  public delegate bool EnumWindowsProc(IntPtr handle, IntPtr state);

  public sealed class WindowInfo {
    public string WindowID;
    public string Identity;
    public string Location;
    public string Title;
    public uint ProcessID;
    public int X;
    public int Y;
    public int Width;
    public int Height;
    public bool Minimized;
    public bool Foreground;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct Rect { public int Left; public int Top; public int Right; public int Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  public struct Point { public int X; public int Y; }

  [StructLayout(LayoutKind.Sequential)]
  public struct Input { public uint Type; public InputUnion Value; }

  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)] public MouseInput Mouse;
    [FieldOffset(0)] public KeyboardInput Keyboard;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct MouseInput {
    public int X;
    public int Y;
    public uint Data;
    public uint Flags;
    public uint Time;
    public IntPtr Extra;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct KeyboardInput {
    public ushort VirtualKey;
    public ushort Scan;
    public uint Flags;
    public uint Time;
    public IntPtr Extra;
  }

  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr state);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr handle);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr GetProp(IntPtr handle, string name);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool SetProp(IntPtr handle, string name, IntPtr value);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr handle);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint source, uint target, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out Rect rect);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr handle, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr handle, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint process);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr handle, uint flags);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr handle);
  [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr handle, IntPtr context);
  [DllImport("user32.dll")] public static extern uint SendInput(uint count, Input[] inputs, int size);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr handle, int attribute, out int value, int size);
  [DllImport("gdi32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool StretchBlt(IntPtr destination, int targetX, int targetY, int targetWidth, int targetHeight, IntPtr source, int sourceX, int sourceY, int sourceWidth, int sourceHeight, uint operation);
  [DllImport("gdi32.dll")] private static extern int SetStretchBltMode(IntPtr context, int mode);
  [DllImport("gdi32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool SetBrushOrgEx(IntPtr context, int x, int y, out Point previous);

  public static void EnableDpiAwareness() {
    var previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
    if (previous == IntPtr.Zero)
      throw new InvalidOperationException("Windows refused per-monitor DPI awareness; desktop coordinates are unsafe");
  }

  public static void Capture(IntPtr destination, int targetWidth, int targetHeight, int sourceX, int sourceY, int sourceWidth, int sourceHeight) {
    var source = GetDC(IntPtr.Zero);
    if (source == IntPtr.Zero) throw new InvalidOperationException("Windows screen capture context is unavailable");
    try {
      if (SetStretchBltMode(destination, 4) == 0)
        throw new InvalidOperationException("Windows refused high-quality desktop capture scaling");
      Point previous;
      if (!SetBrushOrgEx(destination, 0, 0, out previous))
        throw new InvalidOperationException("Windows refused desktop capture alignment");
      if (!StretchBlt(destination, 0, 0, targetWidth, targetHeight, source, sourceX, sourceY, sourceWidth, sourceHeight, 0x00CC0020))
        throw new InvalidOperationException("Windows refused scaled desktop capture");
    } finally {
      ReleaseDC(IntPtr.Zero, source);
    }
  }

  private static WindowInfo Describe(IntPtr handle) {
    if (handle == IntPtr.Zero || !IsWindow(handle) || !IsWindowVisible(handle)) return null;
    int cloaked;
    if (DwmGetWindowAttribute(handle, 14, out cloaked, sizeof(int)) == 0 && cloaked != 0) return null;
    var rect = new Rect();
    if (!GetWindowRect(handle, out rect)) return null;
    var width = rect.Right - rect.Left;
    var height = rect.Bottom - rect.Top;
    if (width <= 0 || height <= 0) return null;
    var title = new StringBuilder(2048);
    GetWindowText(handle, title, title.Capacity);
    if (title.Length == 0) return null;
    var kind = new StringBuilder(512);
    GetClassName(handle, kind, kind.Capacity);
    uint process;
    GetWindowThreadProcessId(handle, out process);
    string identity = null;
    try {
      using (var owner = System.Diagnostics.Process.GetProcessById((int)process))
      using (var hash = System.Security.Cryptography.SHA256.Create()) {
        var source = String.Format("pid:{0};start:{1};class:{2}", process, owner.StartTime.ToUniversalTime().Ticks, kind.ToString());
        var instance = GetProp(handle, InstanceProperty);
        if (instance != IntPtr.Zero) source += ";instance:" + instance.ToInt64().ToString(System.Globalization.CultureInfo.InvariantCulture);
        identity = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(source))).Replace("-", "");
      }
    } catch (Exception error) {
      System.Diagnostics.Debug.WriteLine("Raya window process identity unavailable: " + error.GetType().Name);
      identity = null;
    }
    return new WindowInfo {
      WindowID = String.Format("0x{0:X}", handle.ToInt64()),
      Identity = identity,
      Location = String.Format("pid:{0};class:{1};title:{2}", process, kind.ToString(), title.ToString()),
      Title = title.ToString(),
      ProcessID = process,
      X = rect.Left,
      Y = rect.Top,
      Width = width,
      Height = height,
      Minimized = IsIconic(handle),
      Foreground = handle == GetForegroundWindow()
    };
  }

  public static WindowInfo[] Windows() {
    var windows = new List<WindowInfo>();
    EnumWindows((handle, state) => {
      var info = Describe(handle);
      if (info != null) windows.Add(info);
      return windows.Count <= 64;
    }, IntPtr.Zero);
    if (windows.Count > 64) throw new InvalidOperationException("More than 64 visible desktop windows are open; close unused windows and try again");
    return windows.ToArray();
  }

  public static string Identity(long value) {
    var info = Describe(new IntPtr(value));
    return info == null ? null : info.Identity;
  }

  public static string PinForeground(long value) {
    var handle = new IntPtr(value);
    if (GetForegroundWindow() != handle) throw new InvalidOperationException("Selected desktop window is no longer foreground");
    var before = Describe(handle);
    if (before == null || before.Identity == null) throw new InvalidOperationException("Selected desktop window has no stable identity");
    var instance = GetProp(handle, InstanceProperty);
    if (instance == IntPtr.Zero) {
      var bytes = new byte[8];
      using (var random = RandomNumberGenerator.Create()) random.GetBytes(bytes);
      var value64 = BitConverter.ToInt64(bytes, 0) & Int64.MaxValue;
      if (value64 == 0) value64 = 1;
      instance = new IntPtr(value64);
      if (!SetProp(handle, InstanceProperty, instance) || GetProp(handle, InstanceProperty) != instance)
        throw new InvalidOperationException("Windows refused to bind the selected window; choose all visible applications");
    }
    var after = Describe(handle);
    if (after == null || after.WindowID != before.WindowID || after.Location != before.Location ||
        after.ProcessID != before.ProcessID || after.Identity == null || GetForegroundWindow() != handle)
      throw new InvalidOperationException("Selected desktop window changed while binding its identity");
    return after.Identity;
  }

  public static void Focus(long value, string location, string identity, int x, int y, int width, int height, bool minimized, bool foreground) {
    var handle = new IntPtr(value);
    var info = Describe(handle);
    if (info == null || info.Location != location || (identity != null && info.Identity != identity) || info.X != x || info.Y != y || info.Width != width || info.Height != height || info.Minimized != minimized || info.Foreground != foreground)
      throw new InvalidOperationException("Desktop window changed before focus");
    ValidateIdleInput();
    uint ignored;
    var current = GetCurrentThreadId();
    var before = GetForegroundWindow();
    var foregroundThread = before == IntPtr.Zero ? 0 : GetWindowThreadProcessId(before, out ignored);
    var targetThread = GetWindowThreadProcessId(handle, out ignored);
    var foregroundAttached = foregroundThread != 0 && foregroundThread != current && AttachThreadInput(current, foregroundThread, true);
    var targetAttached = targetThread != 0 && targetThread != current && targetThread != foregroundThread && AttachThreadInput(current, targetThread, true);
    try {
      if (info.Minimized) ShowWindow(handle, 9);
      BringWindowToTop(handle);
      if (!SetForegroundWindow(handle)) throw new InvalidOperationException("Windows refused to focus the selected window");
      SetFocus(handle);
    } finally {
      if (targetAttached) AttachThreadInput(current, targetThread, false);
      if (foregroundAttached) AttachThreadInput(current, foregroundThread, false);
    }
    for (var attempt = 0; attempt < 10 && GetForegroundWindow() != handle; attempt++) Thread.Sleep(25);
    if (GetForegroundWindow() != handle) throw new InvalidOperationException("Windows did not foreground the selected window");
  }

  public static void Mouse(uint flags, uint data) {
    var input = new Input {
      Type = 0,
      Value = new InputUnion { Mouse = new MouseInput { Flags = flags, Data = data } }
    };
    if (SendInput(1, new[] { input }, Marshal.SizeOf(typeof(Input))) != 1) throw new InvalidOperationException("Windows refused desktop mouse input");
  }

  public static void Scroll(int deltaX, int deltaY) {
    ValidateIdleInput();
    var inputs = new List<Input>();
    if (deltaY != 0) {
      inputs.Add(new Input {
        Type = 0,
        Value = new InputUnion { Mouse = new MouseInput { Flags = 0x0800, Data = unchecked((uint)deltaY) } }
      });
    }
    if (deltaX != 0) {
      inputs.Add(new Input {
        Type = 0,
        Value = new InputUnion { Mouse = new MouseInput { Flags = 0x1000, Data = unchecked((uint)deltaX) } }
      });
    }
    if (inputs.Count == 0) throw new InvalidOperationException("Desktop scroll requires non-zero movement");
    var batch = inputs.ToArray();
    if (SendInput((uint)batch.Length, batch, Marshal.SizeOf(typeof(Input))) != (uint)batch.Length)
      throw new InvalidOperationException("Windows refused complete desktop scroll input");
  }

  public static void Move(int x, int y) {
    ValidatePoint(x, y);
    ValidateTarget(x, y);
    ValidateIdleInput();
    if (!SetCursorPos(x, y)) throw new InvalidOperationException("Windows refused desktop pointer movement");
    Point point;
    if (!GetCursorPos(out point) || point.X != x || point.Y != y)
      throw new InvalidOperationException("Windows did not move the pointer to the exact desktop point");
  }

  public static void Drag(int startX, int startY, int endX, int endY, int expectedStartX, int expectedStartY, int expectedEndX, int expectedEndY, uint down, uint up) {
    ValidatePoint(expectedStartX, expectedStartY);
    ValidatePoint(expectedEndX, expectedEndY);
    ValidateTarget(expectedStartX, expectedStartY);
    ValidateTarget(expectedEndX, expectedEndY);
    ValidateIdleInput();
    var inputs = new[] {
      new Input { Type = 0, Value = new InputUnion { Mouse = new MouseInput { X = startX, Y = startY, Flags = 0xC001 } } },
      new Input { Type = 0, Value = new InputUnion { Mouse = new MouseInput { Flags = down } } },
      new Input { Type = 0, Value = new InputUnion { Mouse = new MouseInput { X = endX, Y = endY, Flags = 0xC001 } } },
      new Input { Type = 0, Value = new InputUnion { Mouse = new MouseInput { Flags = up } } }
    };
    var accepted = SendInput(4, inputs, Marshal.SizeOf(typeof(Input)));
    if (accepted == 4) {
      Point point;
      if (GetCursorPos(out point) && point.X == expectedEndX && point.Y == expectedEndY) return;
      throw new InvalidOperationException("Windows did not finish the drag at the exact desktop point");
    }
    if (UnmatchedMouseDown(inputs, accepted, down, up)) Mouse(up, 0);
    throw new InvalidOperationException("Windows refused complete desktop drag input");
  }

  private static void ValidatePoint(int x, int y) {
    var left = GetSystemMetrics(76);
    var top = GetSystemMetrics(77);
    var width = GetSystemMetrics(78);
    var height = GetSystemMetrics(79);
    if (width <= 1 || height <= 1 || x < left || y < top || x >= left + width || y >= top + height)
      throw new InvalidOperationException("Desktop point is outside the physical virtual desktop");
  }

  private static void ValidateTarget(int x, int y) {
    var foreground = GetForegroundWindow();
    var target = WindowFromPoint(new Point { X = x, Y = y });
    if (foreground == IntPtr.Zero || target == IntPtr.Zero)
      throw new InvalidOperationException("Desktop point has no verifiable foreground target");
    var foregroundRoot = GetAncestor(foreground, 3);
    var targetRoot = GetAncestor(target, 3);
    if ((foregroundRoot == IntPtr.Zero ? foreground : foregroundRoot) != (targetRoot == IntPtr.Zero ? target : targetRoot))
      throw new InvalidOperationException("Another application covers the grounded desktop point");
  }

  private static void ValidateIdleInput() {
    for (var key = 1; key < 256; key++) {
      if ((GetAsyncKeyState(key) & 0x8000) != 0)
        throw new InvalidOperationException("Manual keyboard or pointer input is held; desktop control was not dispatched");
    }
  }

  public static bool UnmatchedMouseDown(Input[] inputs, uint accepted, uint down, uint up) {
    var held = false;
    for (var position = 0; position < accepted && position < inputs.Length; position++) {
      if (inputs[position].Value.Mouse.Flags == down) held = true;
      if (inputs[position].Value.Mouse.Flags == up) held = false;
    }
    return held;
  }

  public static void Click(int x, int y, int expectedX, int expectedY, uint down, uint up, bool twice) {
    ValidatePoint(expectedX, expectedY);
    ValidateTarget(expectedX, expectedY);
    ValidateIdleInput();
    var inputs = new List<Input> {
      new Input { Type = 0, Value = new InputUnion { Mouse = new MouseInput { X = x, Y = y, Flags = 0xC001 } } },
      new Input { Type = 0, Value = new InputUnion { Mouse = new MouseInput { Flags = down } } },
      new Input { Type = 0, Value = new InputUnion { Mouse = new MouseInput { Flags = up } } }
    };
    if (twice) {
      inputs.Add(new Input { Type = 0, Value = new InputUnion { Mouse = new MouseInput { Flags = down } } });
      inputs.Add(new Input { Type = 0, Value = new InputUnion { Mouse = new MouseInput { Flags = up } } });
    }
    var batch = inputs.ToArray();
    var accepted = SendInput((uint)batch.Length, batch, Marshal.SizeOf(typeof(Input)));
    if (accepted == (uint)batch.Length) {
      Point point;
      if (GetCursorPos(out point) && point.X == expectedX && point.Y == expectedY) return;
      throw new InvalidOperationException("Windows did not click the exact desktop point");
    }
    if (UnmatchedMouseDown(batch, accepted, down, up)) Mouse(up, 0);
    throw new InvalidOperationException("Windows refused complete desktop click input");
  }

  public static void Chord(ushort key, ushort[] modifiers) {
    ValidateIdleInput();
    var inputs = new Input[(modifiers.Length * 2) + 2];
    var index = 0;
    foreach (var modifier in modifiers) {
      inputs[index++] = new Input {
        Type = 1,
        Value = new InputUnion { Keyboard = new KeyboardInput { VirtualKey = modifier } }
      };
    }
    inputs[index++] = new Input {
      Type = 1,
      Value = new InputUnion { Keyboard = new KeyboardInput { VirtualKey = key } }
    };
    inputs[index++] = new Input {
      Type = 1,
      Value = new InputUnion { Keyboard = new KeyboardInput { VirtualKey = key, Flags = 2u } }
    };
    for (var position = modifiers.Length - 1; position >= 0; position--) {
      inputs[index++] = new Input {
        Type = 1,
        Value = new InputUnion { Keyboard = new KeyboardInput { VirtualKey = modifiers[position], Flags = 2u } }
      };
    }
    var accepted = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input)));
    if (accepted == (uint)inputs.Length) return;
    foreach (var held in HeldKeys(inputs, accepted)) Release(held);
    throw new InvalidOperationException("Windows refused complete desktop key input");
  }

  public static ushort[] HeldKeys(Input[] inputs, uint accepted) {
    var held = new List<ushort>();
    for (var position = 0; position < accepted; position++) {
      var input = inputs[position].Value.Keyboard;
      if ((input.Flags & 2u) == 0) {
        held.Add(input.VirtualKey);
        continue;
      }
      var match = held.LastIndexOf(input.VirtualKey);
      if (match >= 0) held.RemoveAt(match);
    }
    held.Reverse();
    return held.ToArray();
  }

  private static bool Release(ushort key) {
    var input = new Input {
      Type = 1,
      Value = new InputUnion { Keyboard = new KeyboardInput { VirtualKey = key, Flags = 2u } }
    };
    return SendInput(1, new[] { input }, Marshal.SizeOf(typeof(Input))) == 1;
  }

  public static void Text(string text) {
    ValidateIdleInput();
    var inputs = new Input[checked(text.Length * 2)];
    for (var position = 0; position < text.Length; position++) {
      var down = new Input {
        Type = 1,
        Value = new InputUnion { Keyboard = new KeyboardInput { Scan = text[position], Flags = 4u } }
      };
      var up = down;
      up.Value.Keyboard.Flags = 6u;
      inputs[position * 2] = down;
      inputs[(position * 2) + 1] = up;
    }
    var accepted = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input)));
    if (accepted == (uint)inputs.Length) return;
    if (accepted % 2 == 1 && accepted < (uint)inputs.Length)
      SendInput(1, new[] { inputs[accepted] }, Marshal.SizeOf(typeof(Input)));
    throw new InvalidOperationException("Windows refused complete desktop text input");
  }
}
`

const setup = String.raw`
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
if (-not ("RayaDesktopNative" -as [type])) {
Add-Type -TypeDefinition @'
${native}
'@
}
[RayaDesktopNative]::EnableDpiAwareness()

function Get-RayaWindow {
  $handle = [RayaDesktopNative]::GetForegroundWindow()
  if ($handle -eq [IntPtr]::Zero) { throw "Windows has no foreground window" }
  $rect = New-Object RayaDesktopNative+Rect
  if (-not [RayaDesktopNative]::GetWindowRect($handle, [ref]$rect)) { throw "Windows refused foreground window bounds" }
  $title = New-Object Text.StringBuilder 2048
  [void][RayaDesktopNative]::GetWindowText($handle, $title, $title.Capacity)
  [uint32]$processID = 0
  [void][RayaDesktopNative]::GetWindowThreadProcessId($handle, [ref]$processID)
  $desktopLeft = [RayaDesktopNative]::GetSystemMetrics(76)
  $desktopTop = [RayaDesktopNative]::GetSystemMetrics(77)
  $desktopWidth = [RayaDesktopNative]::GetSystemMetrics(78)
  $desktopHeight = [RayaDesktopNative]::GetSystemMetrics(79)
  if ($desktopWidth -le 1 -or $desktopHeight -le 1) { throw "Windows virtual desktop bounds are unavailable" }
  $visible = New-Object RayaDesktopNative+Rect
  $visible.Left = [Math]::Max($rect.Left, $desktopLeft)
  $visible.Top = [Math]::Max($rect.Top, $desktopTop)
  $visible.Right = [Math]::Min($rect.Right, $desktopLeft + $desktopWidth)
  $visible.Bottom = [Math]::Min($rect.Bottom, $desktopTop + $desktopHeight)
  $width = $visible.Right - $visible.Left
  $height = $visible.Bottom - $visible.Top
  if ($width -le 0 -or $height -le 0) { throw "Foreground window has no observable area" }
  [pscustomobject]@{
    Handle = $handle
    Rect = $visible
    WindowID = ("0x{0:X}" -f $handle.ToInt64())
    Location = ("pid:{0};title:{1};bounds:{2},{3},{4},{5}" -f $processID, $title.ToString(), $visible.Left, $visible.Top, $width, $height)
    Title = $title.ToString()
    Width = $width
    Height = $height
  }
}
`

const semanticSetup = String.raw`
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
function Get-RayaControls($window) {
  $controls = @()
  $root = [Windows.Automation.AutomationElement]::FromHandle($window.Handle)
  if (-not $root) { throw "Windows UI Automation could not inspect the foreground window" }
  $cache = [Windows.Automation.CacheRequest]::new()
  $cache.TreeScope = [Windows.Automation.TreeScope]::Element -bor [Windows.Automation.TreeScope]::Children
  $cache.Add([Windows.Automation.AutomationElement]::NameProperty)
  $cache.Add([Windows.Automation.AutomationElement]::AutomationIdProperty)
  $cache.Add([Windows.Automation.AutomationElement]::ControlTypeProperty)
  $cache.Add([Windows.Automation.AutomationElement]::BoundingRectangleProperty)
  $cache.Add([Windows.Automation.AutomationElement]::IsEnabledProperty)
  $cache.Add([Windows.Automation.AutomationElement]::HasKeyboardFocusProperty)
  $cache.Add([Windows.Automation.AutomationElement]::IsOffscreenProperty)
  $cache.Add([Windows.Automation.InvokePattern]::Pattern)
  $cache.Add([Windows.Automation.SelectionItemPattern]::Pattern)
  $cache.Add([Windows.Automation.TogglePattern]::Pattern)
  $cache.Add([Windows.Automation.ExpandCollapsePattern]::Pattern)
  $cache.Add([Windows.Automation.ValuePattern]::Pattern)
  $cache.Add([Windows.Automation.ScrollPattern]::Pattern)
  $cache.Add([Windows.Automation.ScrollItemPattern]::Pattern)
  $queue = [Collections.Generic.Queue[object]]::new()
  $queue.Enqueue($root)
  $visited = 0
  $truncated = $false
  while ($queue.Count -gt 0 -and $visited -lt 1024 -and $controls.Count -lt 256) {
    $item = $queue.Dequeue()
    $item = $item.GetUpdatedCache($cache)
    $visited += 1
    $children = $item.CachedChildren
    $remaining = 1024 - $visited - $queue.Count
    $count = [Math]::Min($children.Count, [Math]::Max(0, $remaining))
    for ($index = 0; $index -lt $count; $index += 1) {
      $queue.Enqueue($children[$index])
    }
    if ($children.Count -gt $count) { $truncated = $true }
    try {
      $current = $item.Cached
      if ($current.IsOffscreen) { continue }
      $bounds = $current.BoundingRectangle
      if ([double]::IsNaN($bounds.X) -or [double]::IsNaN($bounds.Y) -or [double]::IsNaN($bounds.Width) -or [double]::IsNaN($bounds.Height)) { continue }
      $x = [int][Math]::Round($bounds.X)
      $y = [int][Math]::Round($bounds.Y)
      $width = [int][Math]::Round($bounds.Width)
      $height = [int][Math]::Round($bounds.Height)
      if ($width -le 0 -or $height -le 0) { continue }
      if ($x -ge $window.Rect.Right -or $y -ge $window.Rect.Bottom -or $x + $width -le $window.Rect.Left -or $y + $height -le $window.Rect.Top) { continue }
      $name = ([string]$current.Name).Trim()
      if ($name.Length -gt 512) { $name = $name.Substring(0, 512) }
      $automationID = ([string]$current.AutomationId).Trim()
      if ($automationID.Length -gt 200) { $automationID = $automationID.Substring(0, 200) }
      $role = ([string]$current.ControlType.ProgrammaticName) -replace '^ControlType\\.', ''
      if (-not $role -or $role.Length -gt 100) { continue }
      $runtime = @($item.GetRuntimeId())
      $controlID = if ($runtime.Count -gt 0) { $runtime -join '.' } else { "control:$visited" }
      if ($controlID.Length -gt 200) { continue }
      $actions = @()
      $pattern = $null
      if ($item.TryGetCachedPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { $actions += 'invoke' }
      if ($item.TryGetCachedPattern([Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) { $actions += 'select' }
      if ($item.TryGetCachedPattern([Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) { $actions += 'toggle' }
      if ($item.TryGetCachedPattern([Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern)) { $actions += 'expand_collapse' }
      if ($item.TryGetCachedPattern([Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) { $actions += 'value' }
      if ($item.TryGetCachedPattern([Windows.Automation.ScrollPattern]::Pattern, [ref]$pattern) -or $item.TryGetCachedPattern([Windows.Automation.ScrollItemPattern]::Pattern, [ref]$pattern)) { $actions += 'scroll' }
      $selected = $null
      $selection = $null
      if ($item.TryGetCachedPattern([Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selection)) {
        $selected = [bool]$selection.Cached.IsSelected
      }
      $controls += [pscustomobject]@{
        controlID = $controlID
        role = $role
        name = if ($name) { $name } else { $null }
        automationID = if ($automationID) { $automationID } else { $null }
        x = $x
        y = $y
        width = $width
        height = $height
        enabled = [bool]$current.IsEnabled
        focused = [bool]$current.HasKeyboardFocus
        selected = $selected
        actions = @($actions)
      }
    } catch {
      continue
    }
  }
  [pscustomobject]@{
    source = 'windows_ui_automation'
    status = 'available'
    viewport = [pscustomobject]@{ x = $window.Rect.Left; y = $window.Rect.Top; width = $window.Width; height = $window.Height }
    controls = @($controls)
    truncated = $truncated -or $queue.Count -gt 0
  }
}
`

function semanticOnly(target: { windowID: string; location: string; identity?: string }) {
  const input = payload(target)
  return `${setup}
${semanticSetup}
$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${input}")) | ConvertFrom-Json
$window = Get-RayaWindow
if ($window.WindowID -ne $target.windowID -or $window.Location -ne $target.location) {
  throw "Foreground window changed before semantic observation"
}
if ($target.identity -and [RayaDesktopNative]::Identity($window.Handle) -ne $target.identity) {
  throw "Desktop process identity changed before semantic observation"
}
$timer = [Diagnostics.Stopwatch]::StartNew()
try {
  $output = @(Get-RayaControls $window)
  $semantics = $output[-1]
  if (-not $semantics -or $semantics.source -ne 'windows_ui_automation') {
    throw "Windows UI Automation returned no bounded observation"
  }
} catch {
  $semantics = [pscustomobject]@{
    source = 'windows_ui_automation'
    status = 'unavailable'
    viewport = [pscustomobject]@{ x = $window.Rect.Left; y = $window.Rect.Top; width = $window.Width; height = $window.Height }
    controls = @()
    truncated = $false
  }
} finally {
  $timer.Stop()
}
$after = Get-RayaWindow
if ($after.WindowID -ne $window.WindowID -or $after.Location -ne $window.Location) {
  throw "Foreground window changed while correlating semantic observations"
}
$identity = if ($target.identity) { [RayaDesktopNative]::Identity($after.Handle) } else { $null }
if ($target.identity -and $identity -ne $target.identity) {
  throw "Desktop process identity changed while correlating semantic observations"
}
[pscustomobject]@{
  windowID = $window.WindowID
  location = $window.Location
  identity = $identity
  semantics = $semantics
  semanticsMs = $timer.Elapsed.TotalMilliseconds
} | ConvertTo-Json -Depth 8 -Compress
`
}

const observe = `${setup}
Add-Type -AssemblyName System.Drawing
${semanticSetup}
$collectSemantics = $true
function Test-RayaImage($stream) {
  if ($stream.Length -le 0) { throw "Desktop capture encoder returned no image" }
  $stream.Position = 0
  try {
    $check = [Drawing.Image]::FromStream($stream, $false, $true)
    $check.Dispose()
  } catch {
    throw "Desktop capture encoder returned an incomplete image"
  } finally {
    $stream.Position = $stream.Length
  }
}
$window = Get-RayaWindow
$scale = [Math]::Min(1.0, [Math]::Min(${CAPTURE.edge}.0 / $window.Width, ${CAPTURE.edge}.0 / $window.Height))
$area = [double]$window.Width * [double]$window.Height
if ($area -gt ${CAPTURE.pixels}) { $scale = [Math]::Min($scale, [Math]::Sqrt(${CAPTURE.pixels}.0 / $area)) }
$width = [Math]::Max(1, [int][Math]::Floor($window.Width * $scale))
$height = [Math]::Max(1, [int][Math]::Floor($window.Height * $scale))
$image = New-Object Drawing.Bitmap $width, $height
$graphics = [Drawing.Graphics]::FromImage($image)
$stream = New-Object RayaBoundedStream ${CAPTURE.bytes}
$mime = "image/png"
$acquisition = [Diagnostics.Stopwatch]::StartNew()
try {
  if ($width -eq $window.Width -and $height -eq $window.Height) {
    $graphics.CopyFromScreen($window.Rect.Left, $window.Rect.Top, 0, 0, $image.Size, [Drawing.CopyPixelOperation]::SourceCopy)
  } else {
    $context = $graphics.GetHdc()
    try {
      [RayaDesktopNative]::Capture($context, $width, $height, $window.Rect.Left, $window.Rect.Top, $window.Width, $window.Height)
    } finally {
      $graphics.ReleaseHdc($context)
    }
  }
  $acquisition.Stop()
  $preparation = [Diagnostics.Stopwatch]::StartNew()
  $region = New-Object Drawing.Rectangle 0, 0, $width, $height
  $bits = $image.LockBits($region, [Drawing.Imaging.ImageLockMode]::ReadOnly, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
  try {
    $size = [Math]::Abs($bits.Stride) * $height
    if ($size -le 0 -or $size -gt ${CAPTURE.pixels * 4}) { throw "Desktop raw frame exceeds the bounded pixel buffer" }
    $pixels = New-Object byte[] $size
    [Runtime.InteropServices.Marshal]::Copy($bits.Scan0, $pixels, 0, $size)
  } finally {
    $image.UnlockBits($bits)
  }
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $digest = ([BitConverter]::ToString($sha.ComputeHash($pixels))).Replace('-', '')
  } finally {
    $sha.Dispose()
  }
  $cache = $global:RayaCaptureCache
  $unchanged = $cache -and $cache.WindowID -eq $window.WindowID -and $cache.Location -eq $window.Location -and $cache.Width -eq $width -and $cache.Height -eq $height -and $cache.Digest -eq $digest
  $data = $null
  if (-not $unchanged) {
    try {
      $image.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
      Test-RayaImage $stream
    } catch {
      $stream.Dispose()
      $stream = New-Object RayaBoundedStream ${CAPTURE.bytes}
      $codec = [Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object MimeType -eq "image/jpeg" | Select-Object -First 1
      if (-not $codec) { throw "Windows JPEG encoder is unavailable" }
      $parameters = New-Object Drawing.Imaging.EncoderParameters 1
      $parameters.Param[0] = New-Object Drawing.Imaging.EncoderParameter ([Drawing.Imaging.Encoder]::Quality), ([long]88)
      try {
        $image.Save($stream, $codec, $parameters)
        Test-RayaImage $stream
      } finally {
        $parameters.Dispose()
      }
      $mime = "image/jpeg"
    }
    $data = [Convert]::ToBase64String($stream.GetBuffer(), 0, [int]$stream.Length)
    $global:RayaCaptureCache = [pscustomobject]@{
      WindowID = $window.WindowID
      Location = $window.Location
      Width = $width
      Height = $height
      Digest = $digest
    }
  }
  $preparation.Stop()
  $semantics = $null
  $semanticsMs = $null
  if ($collectSemantics) {
    $semanticsTimer = [Diagnostics.Stopwatch]::StartNew()
    try {
      $semanticOutput = @(Get-RayaControls $window)
      $semantics = $semanticOutput[-1]
      if (-not $semantics -or $semantics.source -ne 'windows_ui_automation') {
        throw "Windows UI Automation returned no bounded observation"
      }
    } catch {
      $semantics = [pscustomobject]@{
        source = 'windows_ui_automation'
        status = 'unavailable'
        viewport = [pscustomobject]@{ x = $window.Rect.Left; y = $window.Rect.Top; width = $window.Width; height = $window.Height }
        controls = @()
        truncated = $false
      }
    } finally {
      $semanticsTimer.Stop()
      $semanticsMs = $semanticsTimer.Elapsed.TotalMilliseconds
    }
  }
  $after = Get-RayaWindow
  if ($after.WindowID -ne $window.WindowID -or $after.Location -ne $window.Location) {
    throw "Foreground window changed while correlating visual and semantic observations"
  }
  $result = [ordered]@{
    windowID = $window.WindowID
    location = $window.Location
    width = $width
    height = $height
    change = if ($unchanged) { 'unchanged' } else { 'keyframe' }
    acquisitionMs = $acquisition.Elapsed.TotalMilliseconds
    preparationMs = $preparation.Elapsed.TotalMilliseconds
  }
  if ($semantics) { $result['semantics'] = $semantics }
  if ($null -ne $semanticsMs) { $result['semanticsMs'] = $semanticsMs }
  if (-not $unchanged) {
    $result['mime'] = $mime
    $result['data'] = $data
  }
  [pscustomobject]$result | ConvertTo-Json -Depth 8 -Compress
} finally {
  $stream.Dispose()
  $graphics.Dispose()
  $image.Dispose()
}
`

const pixels = observe.replace("$collectSemantics = $true", "$collectSemantics = $false")

const current = `${setup}
$window = Get-RayaWindow
[pscustomobject]@{ windowID = $window.WindowID; location = $window.Location } | ConvertTo-Json -Compress
`

const windows = `${setup}
$items = @([RayaDesktopNative]::Windows() | ForEach-Object {
  [pscustomobject]@{
    windowID = $_.WindowID
    identity = $_.Identity
    location = $_.Location
    title = $_.Title
    processID = [int]$_.ProcessID
    x = $_.X
    y = $_.Y
    width = $_.Width
    height = $_.Height
    minimized = $_.Minimized
    foreground = $_.Foreground
  }
})
[pscustomobject]@{ windows = $items } | ConvertTo-Json -Depth 4 -Compress
`

function identity(windowID: string) {
  const input = payload({ windowID })
  return `${setup}
$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${input}")) | ConvertFrom-Json
if ([string]$target.windowID -notmatch '^0x[0-9A-Fa-f]+$') { throw "Desktop window identity is invalid" }
$value = [Convert]::ToInt64(([string]$target.windowID).Substring(2), 16)
[pscustomobject]@{ identity = [RayaDesktopNative]::Identity($value) } | ConvertTo-Json -Compress
`
}

function currentExact(target: { windowID: string; location: string; identity?: string }) {
  const input = payload(target)
  return `${setup}
$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${input}")) | ConvertFrom-Json
$window = Get-RayaWindow
if ($window.WindowID -ne $target.windowID -or $window.Location -ne $target.location) {
  throw "Desktop target changed after post-action capture"
}
$identity = $null
if ($target.identity) {
  $identity = [RayaDesktopNative]::Identity($window.Handle)
  if ($identity -ne $target.identity) { throw "Desktop process identity changed after post-action capture" }
}
[pscustomobject]@{ windowID = $window.WindowID; location = $window.Location; identity = $identity } | ConvertTo-Json -Compress
`
}

const currentIdentity = `${setup}
$window = Get-RayaWindow
[pscustomobject]@{
  windowID = $window.WindowID
  location = $window.Location
  identity = [RayaDesktopNative]::Identity($window.Handle)
} | ConvertTo-Json -Compress
`

function unbound(frame: { epoch?: number; identity?: string }) {
  return frame.epoch !== undefined && !frame.identity
}

function pinCurrent(windowID: string) {
  const input = payload({ windowID })
  return `${setup}
$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${input}")) | ConvertFrom-Json
$window = Get-RayaWindow
if ($window.WindowID -ne $target.windowID) { throw "Selected desktop window is no longer foreground" }
$identity = [RayaDesktopNative]::PinForeground($window.Handle.ToInt64())
$after = Get-RayaWindow
if ($after.WindowID -ne $window.WindowID -or $after.Location -ne $window.Location -or
    [RayaDesktopNative]::Identity($after.Handle.ToInt64()) -ne $identity) {
  throw "Selected desktop window changed while binding its identity"
}
[pscustomobject]@{ windowID = $after.WindowID; title = $after.Title; identity = $identity } | ConvertTo-Json -Compress
`
}

function focus(target: DesktopWindow) {
  const input = payload(target)
  return `${setup}
$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${input}")) | ConvertFrom-Json
if ([string]$target.windowID -notmatch '^0x[0-9A-Fa-f]+$') { throw "Desktop window identity is invalid" }
$value = [Convert]::ToInt64(([string]$target.windowID).Substring(2), 16)
[RayaDesktopNative]::Focus(
  $value,
  [string]$target.location,
  $(if ($target.identity) { [string]$target.identity } else { $null }),
  [int]$target.x,
  [int]$target.y,
  [int]$target.width,
  [int]$target.height,
  [bool]$target.minimized,
  [bool]$target.foreground
)
`
}

function payload(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64")
}

function perform(action: DesktopAction, target: { windowID: string; location?: string; identity?: string }) {
  const input = payload({ action, target })
  return `${setup}
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${input}")) | ConvertFrom-Json
$window = Get-RayaWindow
if ($window.WindowID -ne $payload.target.windowID -or $window.Location -ne $payload.target.location) { throw "Foreground window changed before desktop input" }
if ($payload.target.identity -and [RayaDesktopNative]::Identity($window.Handle) -ne [string]$payload.target.identity) { throw "Selected desktop window process identity changed before input" }
$action = $payload.action

switch ($action.operation) {
  "pointer" {
    $x = $window.Rect.Left + [Math]::Min($window.Width - 1, [Math]::Max(0, [Math]::Round($action.x * ($window.Width - 1))))
    $y = $window.Rect.Top + [Math]::Min($window.Height - 1, [Math]::Max(0, [Math]::Round($action.y * ($window.Height - 1))))
    if ($action.action -eq "move") {
      [RayaDesktopNative]::Move($x, $y)
      break
    }
    $left = [RayaDesktopNative]::GetSystemMetrics(76)
    $top = [RayaDesktopNative]::GetSystemMetrics(77)
    $width = [RayaDesktopNative]::GetSystemMetrics(78)
    $height = [RayaDesktopNative]::GetSystemMetrics(79)
    if ($width -le 1 -or $height -le 1) { throw "Windows virtual desktop bounds are unavailable" }
    $absoluteX = [Math]::Round((($x - $left) * 65535.0) / ($width - 1))
    $absoluteY = [Math]::Round((($y - $top) * 65535.0) / ($height - 1))
    $down = if ($action.button -eq "right") { 0x0008 } else { 0x0002 }
    $up = if ($action.button -eq "right") { 0x0010 } else { 0x0004 }
    [RayaDesktopNative]::Click($absoluteX, $absoluteY, $x, $y, $down, $up, $action.action -eq "double_click")
  }
  "drag" {
    $startX = $window.Rect.Left + [Math]::Min($window.Width - 1, [Math]::Max(0, [Math]::Round($action.startX * ($window.Width - 1))))
    $startY = $window.Rect.Top + [Math]::Min($window.Height - 1, [Math]::Max(0, [Math]::Round($action.startY * ($window.Height - 1))))
    $endX = $window.Rect.Left + [Math]::Min($window.Width - 1, [Math]::Max(0, [Math]::Round($action.endX * ($window.Width - 1))))
    $endY = $window.Rect.Top + [Math]::Min($window.Height - 1, [Math]::Max(0, [Math]::Round($action.endY * ($window.Height - 1))))
    $left = [RayaDesktopNative]::GetSystemMetrics(76)
    $top = [RayaDesktopNative]::GetSystemMetrics(77)
    $width = [RayaDesktopNative]::GetSystemMetrics(78)
    $height = [RayaDesktopNative]::GetSystemMetrics(79)
    if ($width -le 1 -or $height -le 1) { throw "Windows virtual desktop bounds are unavailable" }
    $absoluteStartX = [Math]::Round((($startX - $left) * 65535.0) / ($width - 1))
    $absoluteStartY = [Math]::Round((($startY - $top) * 65535.0) / ($height - 1))
    $absoluteEndX = [Math]::Round((($endX - $left) * 65535.0) / ($width - 1))
    $absoluteEndY = [Math]::Round((($endY - $top) * 65535.0) / ($height - 1))
    $down = if ($action.button -eq "right") { 0x0008 } else { 0x0002 }
    $up = if ($action.button -eq "right") { 0x0010 } else { 0x0004 }
    [RayaDesktopNative]::Drag($absoluteStartX, $absoluteStartY, $absoluteEndX, $absoluteEndY, $startX, $startY, $endX, $endY, $down, $up)
  }
  "type" { [RayaDesktopNative]::Text([string]$action.text) }
  "scroll" {
    [RayaDesktopNative]::Scroll([int][Math]::Round($action.deltaX), [int][Math]::Round($action.deltaY))
  }
  "key" {
    $keys = @{
      "Backspace" = 0x08; "Tab" = 0x09; "Enter" = 0x0D; "Shift" = 0x10; "Control" = 0x11;
      "Alt" = 0x12; "Escape" = 0x1B; "Space" = 0x20; "PageUp" = 0x21; "PageDown" = 0x22;
      "End" = 0x23; "Home" = 0x24; "ArrowLeft" = 0x25; "ArrowUp" = 0x26; "ArrowRight" = 0x27;
      "ArrowDown" = 0x28; "Delete" = 0x2E; "Meta" = 0x5B;
    }
    $mods = @{ "shift" = 0x10; "control" = 0x11; "alt" = 0x12; "meta" = 0x5B }
    $held = @()
    foreach ($modifier in @($action.modifiers)) {
      $code = $mods[[string]$modifier]
      if (-not $code) { throw "Unsupported desktop modifier" }
      $held += $code
    }
    $name = [string]$action.key
    $key = $keys[$name]
    if (-not $key -and $name.Length -eq 1) { $key = [int][char]$name.ToUpperInvariant() }
    if (-not $key -and $name -match '^F([1-9]|1[0-2])$') { $key = 0x6F + [int]$Matches[1] }
    if (-not $key) { throw "Unsupported desktop key" }
    [RayaDesktopNative]::Chord([uint16]$key, [uint16[]]$held)
  }
}
`
}

export type Runner = { run(script: string): Promise<string>; cancel(): void }
const HOST_OUTPUT = 30 * 1024 * 1024

const host = String.raw`
$ErrorActionPreference = "Stop"
while (($line = [Console]::In.ReadLine()) -ne $null) {
  try {
    $script = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))
    $result = & ([ScriptBlock]::Create($script)) | Out-String
    $body = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($result.Trim()))
    [Console]::Out.WriteLine("ok $body")
  } catch {
    $message = [string]$_.Exception.Message
    $body = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($message.Substring(0, [Math]::Min(2000, $message.Length))))
    [Console]::Out.WriteLine("error $body")
  }
}
`

export function runner(): Runner {
  let child: ChildProcessWithoutNullStreams | undefined
  let active: { resolve(value: string): void; reject(error: Error): void } | undefined
  let stdout = ""
  let stderr = ""

  const stop = (error: Error) => {
    const pending = active
    active = undefined
    if (pending) pending.reject(error)
  }

  const start = () => {
    if (child) return child
    const process = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(host, "utf16le").toString("base64")],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    )
    stdout = ""
    stderr = ""
    process.stdout.setEncoding("utf8")
    process.stderr.setEncoding("utf8")
    process.stdout.on("data", (chunk: string) => {
      if (child !== process) return
      stdout += chunk
      if (Buffer.byteLength(stdout, "utf8") > HOST_OUTPUT) {
        if (child !== process) return
        child = undefined
        stop(new Error("Windows desktop host response exceeds the bounded output limit"))
        process.kill()
        return
      }
      const lines = stdout.split(/\r?\n/)
      stdout = lines.pop() ?? ""
      for (const line of lines) {
        if (!line) continue
        const pending = active
        active = undefined
        if (!pending) continue
        const split = line.indexOf(" ")
        const status = split < 0 ? line : line.slice(0, split)
        const value = split < 0 ? "" : line.slice(split + 1)
        const decoded = Buffer.from(value, "base64").toString("utf8")
        if (status === "ok") pending.resolve(decoded)
        else pending.reject(new Error(decoded || "Windows desktop host command failed"))
      }
    })
    process.stderr.on("data", (chunk: string) => {
      if (child !== process) return
      stderr = (stderr + chunk).slice(-2000)
    })
    process.once("error", (error) => {
      if (child !== process) return
      child = undefined
      stop(new Error((stderr.trim() || error.message).slice(0, 2000), { cause: error }))
    })
    process.once("exit", (code) => {
      if (child !== process) return
      child = undefined
      stop(new Error((stderr.trim() || `Windows desktop host exited with code ${code ?? "unknown"}`).slice(0, 2000)))
    })
    child = process
    return process
  }

  return {
    run: (script) =>
      new Promise((resolve, reject) => {
        if (active) {
          reject(new Error("A Windows desktop driver command is already active"))
          return
        }
        const process = start()
        const pending = { resolve, reject }
        active = pending
        stderr = ""
        process.stdin.write(`${Buffer.from(script, "utf8").toString("base64")}\n`, "utf8", (error) => {
          if (!error || active !== pending) return
          stop(new Error(error.message, { cause: error }))
        })
      }),
    cancel: () => {
      const process = child
      child = undefined
      stop(new Error("Windows desktop driver command was cancelled"))
      process?.kill()
    },
  }
}

function object(value: string) {
  if (!value) throw new Error("Windows desktop driver returned no result")
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== "object") throw new Error("Windows desktop driver returned invalid JSON")
  return parsed as Record<string, unknown>
}

const semanticActions = new Set<DesktopControl["actions"][number]>([
  "invoke",
  "select",
  "toggle",
  "expand_collapse",
  "value",
  "scroll",
])

function optional(value: unknown, limit: number): value is string | null | undefined {
  if (value === null || value === undefined) return true
  return typeof value === "string" && value.length <= limit
}

function required(value: unknown, limit: number, label: string): string {
  if (typeof value !== "string" || !value || value.length > limit)
    throw new Error(`Windows UI Automation control ${label} is incomplete`)
  return value
}

function bounds(input: Record<string, unknown>) {
  if (![input.x, input.y, input.width, input.height].every(Number.isInteger))
    throw new Error("Windows UI Automation control bounds are invalid")
  if ((input.width as number) <= 0 || (input.height as number) <= 0)
    throw new Error("Windows UI Automation control bounds are empty")
  return {
    x: input.x as number,
    y: input.y as number,
    width: input.width as number,
    height: input.height as number,
  }
}

function state(input: Record<string, unknown>) {
  if (typeof input.enabled !== "boolean" || typeof input.focused !== "boolean")
    throw new Error("Windows UI Automation control state is incomplete")
  if (input.selected !== null && input.selected !== undefined && typeof input.selected !== "boolean")
    throw new Error("Windows UI Automation selection state is invalid")
  return {
    enabled: input.enabled,
    focused: input.focused,
    ...(typeof input.selected === "boolean" ? { selected: input.selected } : {}),
  }
}

function viewport(value: unknown): DesktopSemantics["viewport"] {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Windows UI Automation viewport is invalid")
  const input = value as Record<string, unknown>
  if (![input.x, input.y, input.width, input.height].every(Number.isInteger))
    throw new Error("Windows UI Automation viewport bounds are invalid")
  if ((input.width as number) <= 0 || (input.height as number) <= 0)
    throw new Error("Windows UI Automation viewport is empty")
  return {
    x: input.x as number,
    y: input.y as number,
    width: input.width as number,
    height: input.height as number,
  }
}

function actions(value: unknown): DesktopControl["actions"] {
  if (!Array.isArray(value) || value.length > semanticActions.size)
    throw new Error("Windows UI Automation control actions are incomplete")
  if (
    !value.every((item) => typeof item === "string" && semanticActions.has(item as DesktopControl["actions"][number]))
  )
    throw new Error("Windows UI Automation control actions are invalid")
  return value as DesktopControl["actions"]
}

function control(value: unknown, index: number): DesktopControl {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(
      `Windows UI Automation control ${index} is invalid (${value === null ? "null" : Array.isArray(value) ? "array" : typeof value})`,
    )
  const input = value as Record<string, unknown>
  const controlID = required(input.controlID, 200, "identity")
  const role = required(input.role, 100, "role")
  if (!optional(input.name, 512) || !optional(input.automationID, 200))
    throw new Error("Windows UI Automation control name is invalid")
  return {
    controlID,
    role,
    ...(typeof input.name === "string" && input.name ? { name: input.name } : {}),
    ...(typeof input.automationID === "string" && input.automationID ? { automationID: input.automationID } : {}),
    ...bounds(input),
    ...state(input),
    actions: actions(input.actions),
  }
}

function semantics(value: unknown): DesktopSemantics | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== "object") throw new Error("Windows UI Automation observation is invalid")
  const input = value as Record<string, unknown>
  if (
    input.source !== "windows_ui_automation" ||
    (input.status !== "available" && input.status !== "unavailable") ||
    typeof input.truncated !== "boolean" ||
    !Array.isArray(input.controls) ||
    input.controls.length > 256
  )
    throw new Error("Windows UI Automation observation is incomplete")
  const controls = input.controls.map(control)
  if (input.status === "unavailable" && (controls.length > 0 || input.truncated))
    throw new Error("Unavailable Windows UI Automation observation contains controls")
  return {
    source: input.source,
    status: input.status,
    viewport: viewport(input.viewport),
    controls,
    truncated: input.truncated,
  }
}

function image(
  input: Record<string, unknown>,
): Pick<DesktopFrame, "windowID" | "location" | "width" | "height" | "mime" | "data"> {
  if (typeof input.windowID !== "string" || typeof input.location !== "string")
    throw new Error("Windows desktop observation identity is incomplete")
  if (typeof input.width !== "number" || typeof input.height !== "number")
    throw new Error("Windows desktop observation dimensions are incomplete")
  if (!Number.isInteger(input.width) || !Number.isInteger(input.height))
    throw new Error("Windows desktop observation dimensions are invalid")
  if (input.width <= 0 || input.height <= 0 || input.width > CAPTURE.edge || input.height > CAPTURE.edge)
    throw new Error("Windows desktop observation dimensions exceed the safe capture bounds")
  if (input.width * input.height > CAPTURE.pixels)
    throw new Error("Windows desktop observation pixel count exceeds the safe capture bounds")
  if (input.mime !== "image/png" && input.mime !== "image/jpeg")
    throw new Error("Windows desktop observation image type is invalid")
  if (typeof input.data !== "string" || Buffer.byteLength(input.data, "ascii") > CAPTURE.data)
    throw new Error("Windows desktop observation image is incomplete")
  return {
    windowID: input.windowID,
    location: input.location,
    width: input.width,
    height: input.height,
    mime: input.mime,
    data: input.data,
  }
}

function visual(
  input: Record<string, unknown>,
  prior: Pick<DesktopFrame, "windowID" | "location" | "width" | "height" | "mime" | "data"> | undefined,
) {
  if (input.change === undefined || input.change === "keyframe") return image(input)
  if (input.change !== "unchanged") throw new Error("Windows desktop observation change state is invalid")
  if (input.mime !== undefined || input.data !== undefined)
    throw new Error("Unchanged Windows desktop observation unexpectedly contains encoded pixels")
  if (
    !prior ||
    input.windowID !== prior.windowID ||
    input.location !== prior.location ||
    input.width !== prior.width ||
    input.height !== prior.height
  )
    throw new Error("Unchanged Windows desktop observation has no matching local keyframe")
  return prior
}

function timing(input: Record<string, unknown>, totalMs: number, semantic: DesktopSemantics | undefined) {
  if (typeof input.acquisitionMs !== "number" || typeof input.preparationMs !== "number")
    throw new Error("Windows desktop observation timing is incomplete")
  if (semantic !== undefined && typeof input.semanticsMs !== "number")
    throw new Error("Windows desktop semantic timing is incomplete")
  if (semantic === undefined && input.semanticsMs !== undefined)
    throw new Error("Windows desktop semantic timing has no observation")
  const values = [
    input.acquisitionMs,
    input.preparationMs,
    ...(typeof input.semanticsMs === "number" ? [input.semanticsMs] : []),
    totalMs,
  ]
  if (!values.every((value) => Number.isFinite(value) && value >= 0 && value <= 120_000))
    throw new Error("Windows desktop observation timing is invalid")
  const measured =
    input.acquisitionMs + input.preparationMs + (typeof input.semanticsMs === "number" ? input.semanticsMs : 0)
  if (totalMs < measured) throw new Error("Windows desktop observation timing is inconsistent")
  return {
    acquisitionMs: input.acquisitionMs,
    preparationMs: input.preparationMs,
    ...(typeof input.semanticsMs === "number" ? { semanticsMs: input.semanticsMs } : {}),
    totalMs,
  }
}

function frame(
  input: Record<string, unknown>,
  totalMs: number,
  prior?: Pick<DesktopFrame, "windowID" | "location" | "width" | "height" | "mime" | "data">,
): DesktopFrame {
  const semantic = semantics(input.semantics)
  return {
    ...visual(input, prior),
    ...(semantic ? { semantics: semantic } : {}),
    timing: timing(input, totalMs, semantic),
  }
}

function semanticBounds(location: string, result: DesktopSemantics) {
  const match = /^pid:\d+;title:[\s\S]*;bounds:(-?\d+),(-?\d+),(\d+),(\d+)$/.exec(location)
  if (!match || match.length !== 5) throw new Error("Semantic-only desktop target bounds are invalid")
  const rect = match.slice(1).map(Number)
  if (
    !rect.every(Number.isSafeInteger) ||
    rect[2] <= 0 ||
    rect[3] <= 0 ||
    rect[2] > 32_768 ||
    rect[3] > 32_768 ||
    result.viewport.x !== rect[0] ||
    result.viewport.y !== rect[1] ||
    result.viewport.width !== rect[2] ||
    result.viewport.height !== rect[3]
  )
    throw new Error("Windows UI Automation viewport changed from the exact target bounds")
  return rect
}

function semanticResult(
  input: Record<string, unknown>,
  target: { windowID: string; location: string; identity?: string },
) {
  if (input.windowID !== target.windowID || input.location !== target.location)
    throw new Error("Foreground window changed during semantic observation")
  if (input.mime !== undefined || input.data !== undefined)
    throw new Error("Semantic-only desktop observation unexpectedly contains pixels")
  if (target.identity !== undefined) {
    if (typeof input.identity !== "string" || !/^[A-F0-9]{64}$/.test(input.identity))
      throw new Error("Windows desktop semantic process identity is invalid")
    if (input.identity !== target.identity)
      throw new Error("Desktop process identity changed during semantic observation")
  }
  const result = semantics(input.semantics)
  if (!result) throw new Error("Windows UI Automation observation is missing")
  const rect = semanticBounds(target.location, result)
  if (
    result.controls.some(
      (control) =>
        ![control.x, control.y, control.width, control.height].every(Number.isSafeInteger) ||
        control.x >= rect[0] + rect[2] ||
        control.y >= rect[1] + rect[3] ||
        control.x + control.width <= rect[0] ||
        control.y + control.height <= rect[1],
    )
  )
    throw new Error("Windows UI Automation control lies outside the exact target bounds")
  if (
    typeof input.semanticsMs !== "number" ||
    !Number.isFinite(input.semanticsMs) ||
    input.semanticsMs < 0 ||
    input.semanticsMs > 120_000
  )
    throw new Error("Windows desktop semantic timing is invalid")
  return {
    windowID: target.windowID,
    location: target.location,
    ...(target.identity ? { identity: input.identity as string } : {}),
    semantics: result,
    semanticsMs: input.semanticsMs,
  }
}

export class WindowsDesktopDriver implements DesktopDriver {
  readonly guarded = true as const
  private readonly runner: Runner
  private probe: Runner | undefined
  private preparing: Promise<void> | undefined
  private last: Pick<DesktopFrame, "windowID" | "location" | "width" | "height" | "mime" | "data"> | undefined
  private worker: DesktopCaptureWorker | undefined
  private host: NativeCaptureHost | undefined
  private scope: { windowID: string; identity: string } | undefined

  get postAction(): boolean {
    return !!this.host
  }

  constructor(
    input?: Runner,
    private readonly background?: Runner,
    private readonly binary?: string,
    private readonly args: string[] = [],
    private readonly receiptDir?: string,
    probe?: Runner,
  ) {
    if (!input && process.platform !== "win32") throw new Error("Windows desktop control is available only on Windows")
    this.runner = input ?? runner()
    this.probe = probe
  }

  private async query(script: string): Promise<Record<string, unknown>> {
    const source = (this.probe ??= runner())
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const deadline = new Promise<string>((_, reject) => {
        timer = setTimeout(() => {
          if (this.probe === source) this.cancelProbe()
          reject(new Error("Windows desktop probe timed out"))
        }, 15_000)
      })
      return object(await Promise.race([source.run(script), deadline]))
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  cancelProbe(): void {
    const source = this.probe
    this.probe = undefined
    source?.cancel()
  }

  async probeCurrent(): Promise<{ windowID: string }> {
    const result = await this.query(current)
    if (typeof result.windowID !== "string" || typeof result.location !== "string")
      throw new Error("Windows desktop probe target identity is incomplete")
    return { windowID: result.windowID }
  }

  async probePinCurrent(windowID: string): Promise<{ windowID: string; identity: string }> {
    if (!/^0x[0-9A-F]+$/.test(windowID)) throw new Error("Selected desktop probe window identity is invalid")
    const result = await this.query(pinCurrent(windowID))
    if (
      result.windowID !== windowID ||
      typeof result.title !== "string" ||
      !result.title ||
      result.title.length > 2048 ||
      typeof result.identity !== "string" ||
      !/^[A-F0-9]{64}$/.test(result.identity)
    )
      throw new Error("Selected desktop probe window binding is incomplete")
    return { windowID, identity: result.identity }
  }

  async warmup(): Promise<void> {
    if (this.preparing) return this.preparing
    const pending = this.runner.run("$null").then((result) => {
      if (result !== "") throw new Error("Windows desktop host readiness response is invalid")
    })
    this.preparing = pending
    try {
      await pending
    } finally {
      if (this.preparing === pending) this.preparing = undefined
    }
  }

  async observe(options?: { semantics?: boolean; fresh?: boolean }): Promise<DesktopFrame> {
    const scope = this.scope
    if (options?.semantics === false) {
      const scene = this.warm(options)
      if (scene && (await this.matches(scene))) return this.scoped(scene.frame, scope)
    }
    const candidate = options?.semantics === false ? undefined : this.warm(options)
    if (candidate) {
      const started = performance.now()
      const target = { windowID: candidate.frame.windowID, location: candidate.frame.location ?? "" }
      const result = await this.observeSemantics(target)
      const scene = this.worker?.latest()
      if (scene) {
        if (scene.version !== candidate.version)
          throw new Error("Desktop pixels changed while correlating accessibility controls")
        if (scene.frame.windowID !== target.windowID || scene.frame.location !== target.location)
          throw new Error("Foreground window changed while correlating desktop pixels and controls")
        if (!(await this.matches(scene)))
          throw new Error("Foreground window changed while correlating desktop pixels and controls")
        return this.scoped(
          {
            ...scene.frame,
            semantics: result.semantics,
            timing: {
              ...scene.frame.timing,
              semanticsMs: result.semanticsMs,
              totalMs: Math.max(
                performance.now() - started,
                scene.frame.timing.acquisitionMs + scene.frame.timing.preparationMs,
                result.semanticsMs,
              ),
            },
          },
          scope,
        )
      }
    }
    const started = performance.now()
    const result = object(await this.runner.run(options?.semantics === false ? pixels : observe))
    const next = frame(result, performance.now() - started, this.last)
    await this.scoped(next, scope)
    this.last = {
      windowID: next.windowID,
      location: next.location,
      width: next.width,
      height: next.height,
      mime: next.mime,
      data: next.data,
    }
    return next
  }

  private async scoped(frame: DesktopFrame, scope: { windowID: string; identity: string } | undefined) {
    if (scope !== this.scope) throw new Error("Desktop capture scope changed during observation")
    if (!scope) return frame
    if (frame.windowID !== scope.windowID) throw new Error("Selected desktop window changed during observation")
    await this.verifyCurrent({ windowID: scope.windowID, location: frame.location, identity: scope.identity })
    if (scope !== this.scope) throw new Error("Selected desktop window changed during observation")
    return frame
  }

  async observeAfter(target: DesktopDispatchTarget): Promise<DesktopFrame> {
    const host = this.host
    if (!host) throw new Error("Native post-action capture stopped after dispatch")
    const fallback = async () => {
      if (host !== this.host) throw new Error("Native post-action capture stopped before fallback")
      const frame = await this.observe({ fresh: true })
      if (frame.windowID !== target.windowID || frame.location !== target.location)
        throw new Error("Desktop target changed during post-action capture")
      await this.verifyCurrent(target)
      if (host !== this.host) throw new Error("Native post-action capture stopped during fallback")
      return frame
    }
    if (!target.identity) return fallback()
    if (!/^[0-9A-F]{64}$/.test(target.identity) || !target.location)
      throw new Error("Native post-action target identity is invalid")
    const source = host.latest(Infinity)
    if (!source) return fallback()
    try {
      if (unbound(source)) return fallback()
      if (source.identity !== undefined && source.identity !== target.identity)
        throw new Error("Native post-action process identity changed before capture barrier")
      if (source.windowID !== target.windowID || source.location !== target.location)
        throw new Error("Native post-action target changed before capture barrier")
      const started = performance.now()
      const pending = host.barrierAfter({
        request: randomBytes(16).toString("hex"),
        scene: target.scene,
        source: source.sequence,
        windowID: target.windowID,
        location: target.location,
        identity: target.identity,
      })
      const result = await pending
      if (host !== this.host) {
        if (result.status === "proven") result.frame.data.fill(0)
        throw new Error("Native post-action capture stopped")
      }
      if (result.status === "unproven") {
        if (result.reason === "no_present" || result.reason === "multiple_outputs") return fallback()
        throw new Error(`Native post-action capture could not prove scene continuity: ${result.reason}`)
      }
      const frame = result.frame
      try {
        if (frame.windowID !== target.windowID || frame.location !== target.location)
          throw new Error("Native post-action image changed target")
        if (frame.identity !== undefined && frame.identity !== target.identity)
          throw new Error("Native post-action image changed process identity")
        const result = await this.correlateAfter(host, target, frame.sequence)
        const encoding = performance.now()
        const data = frame.data.toString("base64")
        const preparationMs = frame.preparationMs + performance.now() - encoding
        return {
          windowID: frame.windowID,
          location: frame.location,
          width: frame.width,
          height: frame.height,
          mime: frame.mime,
          data,
          semantics: result.semantics,
          timing: {
            acquisitionMs: frame.acquisitionMs,
            preparationMs,
            semanticsMs: result.semanticsMs,
            totalMs: Math.max(performance.now() - started, preparationMs + frame.acquisitionMs, result.semanticsMs),
          },
        }
      } finally {
        frame.data.fill(0)
      }
    } finally {
      source.data.fill(0)
    }
  }

  private async correlateAfter(host: NativeCaptureHost, target: DesktopDispatchTarget, sequence: number) {
    const result = await this.observeSemantics({
      windowID: target.windowID,
      location: target.location!,
      identity: target.identity,
    })
    const latest = host.latest(Infinity)
    try {
      if (
        host !== this.host ||
        latest?.sequence !== sequence ||
        latest.windowID !== target.windowID ||
        latest.location !== target.location ||
        (latest.identity !== undefined && latest.identity !== target.identity) ||
        result.identity !== target.identity
      )
        throw new Error("Native post-action scene changed while correlating accessibility controls")
    } finally {
      latest?.data.fill(0)
    }
    return result
  }

  private async verifyCurrent(
    target: Pick<DesktopDispatchTarget, "windowID" | "location" | "identity">,
  ): Promise<void> {
    if (!/^0x[0-9A-F]+$/.test(target.windowID) || !target.location || target.location.length > 4096)
      throw new Error("Post-action desktop target identity is invalid")
    if (target.identity !== undefined && !/^[A-F0-9]{64}$/.test(target.identity))
      throw new Error("Post-action desktop process identity is invalid")
    const result = object(
      await this.runner.run(
        currentExact({ windowID: target.windowID, location: target.location, identity: target.identity }),
      ),
    )
    if (
      result.windowID !== target.windowID ||
      result.location !== target.location ||
      (target.identity && result.identity !== target.identity)
    )
      throw new Error("Desktop target changed after post-action capture")
  }

  private warm(options?: { fresh?: boolean }): CapturedScene | undefined {
    return options?.fresh ? undefined : this.worker?.latest()
  }

  async observeSemantics(target: { windowID: string; location: string; identity?: string }) {
    if (!/^0x[0-9A-F]+$/.test(target.windowID) || !target.location || target.location.length > 4096)
      throw new Error("Semantic-only desktop target identity is invalid")
    if (target.identity !== undefined && !/^[A-F0-9]{64}$/.test(target.identity))
      throw new Error("Semantic-only desktop process identity is invalid")
    const output = object(await this.runner.run(semanticOnly(target)))
    return semanticResult(output, target)
  }

  startCapture(failed: (error: unknown) => void, target?: { windowID: string; identity: string }): void {
    if (this.worker) return
    this.scope = target
    if (this.binary && !target) {
      const host = new NativeCaptureHost(
        this.binary,
        (error) => {
          if (this.host === host) this.host = undefined
          this.worker?.stop()
          this.worker = undefined
          failed(error)
        },
        this.args,
        (result) => {
          this.worker?.renew(result.base, result)
        },
        this.receiptDir,
        () => {
          this.worker?.invalidate()
          this.last = undefined
        },
      )
      let sequence = 0
      this.worker = new DesktopCaptureWorker(
        async () => {
          const result = await host.next(sequence)
          sequence = result.sequence
          const started = performance.now()
          const data = result.data.toString("base64")
          result.data.fill(0)
          const preparationMs = result.preparationMs + performance.now() - started
          return {
            windowID: result.windowID,
            location: result.location,
            width: result.width,
            height: result.height,
            mime: result.mime,
            data,
            sourceSequence: result.sequence,
            sourceEpoch: result.epoch,
            sourceIdentity: result.identity,
            timing: {
              acquisitionMs: result.acquisitionMs,
              preparationMs,
              totalMs: result.acquisitionMs + preparationMs,
            },
          }
        },
        () => host.stop(),
        failed,
      )
      try {
        host.start()
        this.host = host
      } catch (error) {
        this.worker.stop()
        this.worker = undefined
        failed(error)
        return
      }
      this.worker.start()
      return
    }
    const source = this.background ?? runner()
    let prior: Pick<DesktopFrame, "windowID" | "location" | "width" | "height" | "mime" | "data"> | undefined
    const discard = () => {
      prior = undefined
      source.cancel()
      return undefined
    }
    this.worker = new DesktopCaptureWorker(
      async () => {
        const started = performance.now()
        const result = object(await source.run(pixels))
        if (target && result.windowID !== target.windowID) return discard()
        const next = frame(result, performance.now() - started, prior)
        if (target) {
          const current = await this.current()
          if (
            current.windowID !== target.windowID ||
            current.location !== next.location ||
            (await this.identity(target.windowID)) !== target.identity
          )
            return discard()
        }
        prior = {
          windowID: next.windowID,
          location: next.location,
          width: next.width,
          height: next.height,
          mime: next.mime,
          data: next.data,
        }
        return next
      },
      () => {
        prior = undefined
        source.cancel()
      },
      failed,
    )
    this.worker.start()
  }

  stopCapture(): void {
    this.scope = undefined
    this.host = undefined
    this.worker?.stop()
    this.worker = undefined
    this.last = undefined
  }

  private async matches(scene: CapturedScene): Promise<boolean> {
    if (scene.sourceEpoch !== undefined && !scene.sourceIdentity) return false
    const current = scene.sourceIdentity ? object(await this.runner.run(currentIdentity)) : await this.current()
    const identity = "identity" in current ? current.identity : undefined
    if (
      typeof current.windowID !== "string" ||
      typeof current.location !== "string" ||
      (scene.sourceIdentity && identity !== null && (typeof identity !== "string" || !/^[A-F0-9]{64}$/.test(identity)))
    )
      throw new Error("Windows desktop current process identity is invalid")
    const latest = this.worker?.latest()
    return (
      latest?.version === scene.version &&
      latest.sourceEpoch === scene.sourceEpoch &&
      latest.sourceIdentity === scene.sourceIdentity &&
      current.windowID === scene.frame.windowID &&
      current.location === scene.frame.location &&
      (!scene.sourceIdentity || identity === scene.sourceIdentity)
    )
  }

  async windows(): Promise<DesktopWindow[]> {
    const result = object(await this.runner.run(windows))
    if (!Array.isArray(result.windows) || result.windows.length > 64)
      throw new Error("Windows desktop window list is incomplete")
    return result.windows.map((value) => {
      if (!value || typeof value !== "object") throw new Error("Windows desktop window entry is invalid")
      const window = value as Record<string, unknown>
      if (
        typeof window.windowID !== "string" ||
        (window.identity !== null && window.identity !== undefined && typeof window.identity !== "string") ||
        typeof window.location !== "string" ||
        typeof window.title !== "string" ||
        typeof window.processID !== "number" ||
        typeof window.x !== "number" ||
        typeof window.y !== "number" ||
        typeof window.width !== "number" ||
        typeof window.height !== "number" ||
        typeof window.minimized !== "boolean" ||
        typeof window.foreground !== "boolean"
      )
        throw new Error("Windows desktop window entry is incomplete")
      return window as DesktopWindow
    })
  }

  async current() {
    const result = object(await this.runner.run(current))
    if (typeof result.windowID !== "string" || typeof result.location !== "string")
      throw new Error("Windows desktop target identity is incomplete")
    return { windowID: result.windowID, location: result.location }
  }

  async identity(windowID: string): Promise<string | undefined> {
    const result = object(await this.runner.run(identity(windowID)))
    if (result.identity === null || result.identity === undefined) return
    if (typeof result.identity !== "string" || !/^[A-F0-9]{64}$/.test(result.identity))
      throw new Error("Windows desktop process identity is invalid")
    return result.identity
  }

  async pinCurrent(windowID: string) {
    if (!/^0x[0-9A-F]+$/.test(windowID)) throw new Error("Selected desktop window identity is invalid")
    const result = object(await this.runner.run(pinCurrent(windowID)))
    if (
      result.windowID !== windowID ||
      typeof result.title !== "string" ||
      !result.title ||
      result.title.length > 2048 ||
      typeof result.identity !== "string" ||
      !/^[A-F0-9]{64}$/.test(result.identity)
    )
      throw new Error("Selected desktop window binding is incomplete")
    return { windowID, title: result.title, identity: result.identity }
  }

  async focus(target: DesktopWindow): Promise<void> {
    await this.runner.run(focus(target))
  }

  async perform(
    action: DesktopAction,
    target: { windowID: string; location?: string; identity?: string },
  ): Promise<void> {
    await this.runner.run(perform(action, target))
  }

  cancel(): void {
    this.stopCapture()
    this.cancelProbe()
    this.last = undefined
    this.runner.cancel()
  }
}
