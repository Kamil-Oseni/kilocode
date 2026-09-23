import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import {
  CAPTURE,
  type DesktopAction,
  type DesktopControl,
  type DesktopDriver,
  type DesktopFrame,
  type DesktopSemantics,
  type DesktopWindow,
} from "./desktop-session"

const native = String.raw`
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
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
  public delegate bool EnumWindowsProc(IntPtr handle, IntPtr state);

  public sealed class WindowInfo {
    public string WindowID;
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
    return new WindowInfo {
      WindowID = String.Format("0x{0:X}", handle.ToInt64()),
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

  public static void Focus(long value, string location, int x, int y, int width, int height, bool minimized, bool foreground) {
    var handle = new IntPtr(value);
    var info = Describe(handle);
    if (info == null || info.Location != location || info.X != x || info.Y != y || info.Width != width || info.Height != height || info.Minimized != minimized || info.Foreground != foreground)
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
    if (SendInput(4, inputs, Marshal.SizeOf(typeof(Input))) == 4) {
      Point point;
      if (GetCursorPos(out point) && point.X == expectedEndX && point.Y == expectedEndY) return;
      throw new InvalidOperationException("Windows did not finish the drag at the exact desktop point");
    }
    Mouse(up, 0);
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
    if (SendInput((uint)batch.Length, batch, Marshal.SizeOf(typeof(Input))) == (uint)batch.Length) {
      Point point;
      if (GetCursorPos(out point) && point.X == expectedX && point.Y == expectedY) return;
      throw new InvalidOperationException("Windows did not click the exact desktop point");
    }
    Mouse(up, 0);
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
    if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input))) == (uint)inputs.Length) return;
    Release(key);
    for (var position = modifiers.Length - 1; position >= 0; position--) Release(modifiers[position]);
    throw new InvalidOperationException("Windows refused complete desktop key input");
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
    Width = $width
    Height = $height
  }
}
`

const observe = `${setup}
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
function Get-RayaControls($window) {
  $controls = @()
  $root = [Windows.Automation.AutomationElement]::FromHandle($window.Handle)
  if (-not $root) { throw "Windows UI Automation could not inspect the foreground window" }
  $cache = [Windows.Automation.CacheRequest]::new()
  $cache.TreeScope = [Windows.Automation.TreeScope]::Element
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
  $root = $root.GetUpdatedCache($cache)
  $queue = [Collections.Generic.Queue[object]]::new()
  $queue.Enqueue($root)
  $walker = [Windows.Automation.TreeWalker]::ControlViewWalker
  $visited = 0
  while ($queue.Count -gt 0 -and $visited -lt 1024 -and $controls.Count -lt 256) {
    $item = $queue.Dequeue()
    $visited += 1
    $child = $walker.GetFirstChild($item, $cache)
    while ($child) {
      $queue.Enqueue($child)
      $child = $walker.GetNextSibling($child, $cache)
    }
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
    truncated = $queue.Count -gt 0
  }
}
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
  $preparation.Stop()
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
  }
  $semanticsTimer.Stop()
  $after = Get-RayaWindow
  if ($after.WindowID -ne $window.WindowID -or $after.Location -ne $window.Location) {
    throw "Foreground window changed while correlating visual and semantic observations"
  }
  [pscustomobject]@{
    windowID = $window.WindowID
    location = $window.Location
    width = $width
    height = $height
    mime = $mime
    data = $data
    semantics = $semantics
    acquisitionMs = $acquisition.Elapsed.TotalMilliseconds
    preparationMs = $preparation.Elapsed.TotalMilliseconds
    semanticsMs = $semanticsTimer.Elapsed.TotalMilliseconds
  } | ConvertTo-Json -Depth 8 -Compress
} finally {
  $stream.Dispose()
  $graphics.Dispose()
  $image.Dispose()
}
`

const current = `${setup}
$window = Get-RayaWindow
[pscustomobject]@{ windowID = $window.WindowID; location = $window.Location } | ConvertTo-Json -Compress
`

const windows = `${setup}
$items = @([RayaDesktopNative]::Windows() | ForEach-Object {
  [pscustomobject]@{
    windowID = $_.WindowID
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

function focus(target: DesktopWindow) {
  const input = payload(target)
  return `${setup}
$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${input}")) | ConvertFrom-Json
if ([string]$target.windowID -notmatch '^0x[0-9A-Fa-f]+$') { throw "Desktop window identity is invalid" }
$value = [Convert]::ToInt64(([string]$target.windowID).Substring(2), 16)
[RayaDesktopNative]::Focus(
  $value,
  [string]$target.location,
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

function perform(action: DesktopAction, target: { windowID: string; location?: string }) {
  const input = payload({ action, target })
  return `${setup}
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${input}")) | ConvertFrom-Json
$window = Get-RayaWindow
if ($window.WindowID -ne $payload.target.windowID -or $window.Location -ne $payload.target.location) { throw "Foreground window changed before desktop input" }
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

function frame(input: Record<string, unknown>, totalMs: number): DesktopFrame {
  const semantic = semantics(input.semantics)
  return {
    ...image(input),
    ...(semantic ? { semantics: semantic } : {}),
    timing: timing(input, totalMs, semantic),
  }
}

export class WindowsDesktopDriver implements DesktopDriver {
  private readonly runner: Runner

  constructor(input?: Runner) {
    if (!input && process.platform !== "win32") throw new Error("Windows desktop control is available only on Windows")
    this.runner = input ?? runner()
  }

  async observe(): Promise<DesktopFrame> {
    const started = performance.now()
    const result = object(await this.runner.run(observe))
    return frame(result, performance.now() - started)
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

  async focus(target: DesktopWindow): Promise<void> {
    await this.runner.run(focus(target))
  }

  async perform(action: DesktopAction, target: { windowID: string; location?: string }): Promise<void> {
    await this.runner.run(perform(action, target))
  }

  cancel(): void {
    this.runner.cancel()
  }
}
