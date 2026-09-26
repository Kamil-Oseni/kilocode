param(
  [Parameter(Mandatory = $true)][ValidateSet('launch', 'interrupt', 'inspect')][string]$Mode,
  [Parameter(Mandatory = $true)][string]$Task
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class RayaRecoveryWindow {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint thread);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder data, uint length, out uint needed);
  public static string Name(IntPtr desktop) {
    if (desktop == IntPtr.Zero) return "";
    uint needed; var data = new StringBuilder(256);
    return GetUserObjectInformation(desktop, 2, data, (uint)data.Capacity * 2, out needed) ? data.ToString() : "";
  }
}
'@

$root = [System.IO.Path]::GetFullPath($Task)
$data = [System.IO.File]::ReadAllText((Join-Path $root 'task.json'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
if ($data.format -ne 'raya.installed-window-recovery-task' -or $data.version -ne 1 -or $data.scenario -ne 'moved-resized-window-recovery') {
  throw 'Invalid window recovery task manifest'
}
$title = "Raya window recovery $($data.code)"

function DesktopNames {
  $thread = [RayaRecoveryWindow]::Name([RayaRecoveryWindow]::GetThreadDesktop([RayaRecoveryWindow]::GetCurrentThreadId()))
  $input = [RayaRecoveryWindow]::OpenInputDesktop(0, $false, 0x0001)
  try { $name = [RayaRecoveryWindow]::Name($input) }
  finally { if ($input -ne [IntPtr]::Zero) { [void][RayaRecoveryWindow]::CloseDesktop($input) } }
  return @{ thread = $thread; input = $name }
}

function Window {
  $handle = [RayaRecoveryWindow]::FindWindow($null, $title)
  if ($handle -eq [IntPtr]::Zero) { throw 'Exact benchmark window is unavailable' }
  $pidValue = [uint32]0
  [void][RayaRecoveryWindow]::GetWindowThreadProcessId($handle, [ref]$pidValue)
  if ($pidValue -eq 0) { throw 'Benchmark window has no process identity' }
  $rect = New-Object RayaRecoveryWindow+Rect
  if (-not [RayaRecoveryWindow]::GetWindowRect($handle, [ref]$rect)) { throw 'Benchmark window bounds are unavailable' }
  return @{ handle = $handle; pid = $pidValue; x = $rect.Left; y = $rect.Top; width = $rect.Right - $rect.Left; height = $rect.Bottom - $rect.Top }
}

if ($Mode -eq 'launch') {
  $form = New-Object System.Windows.Forms.Form
  $form.Text = $title
  $form.StartPosition = 'Manual'
  $form.Location = New-Object System.Drawing.Point(120, 120)
  $form.Size = New-Object System.Drawing.Size(440, 300)
  $form.MinimumSize = New-Object System.Drawing.Size(360, 240)
  $form.MaximizeBox = $false
  $form.AccessibleName = $title

  $prompt = New-Object System.Windows.Forms.Label
  $prompt.Text = "After this window moves, select $($data.expected) ($($data.code))."
  $prompt.AccessibleName = $prompt.Text
  $prompt.AutoSize = $true
  $prompt.Location = New-Object System.Drawing.Point(24, 25)
  $form.Controls.Add($prompt)

  $status = New-Object System.Windows.Forms.Label
  $status.Text = 'Pending; selections 0'
  $status.AccessibleName = $status.Text
  $status.AutoSize = $true
  $status.Location = New-Object System.Drawing.Point(24, 180)
  $form.Controls.Add($status)
  $script:count = 0
  foreach ($label in @('North', 'South')) {
    $button = New-Object System.Windows.Forms.Button
    $button.Text = "$label $($data.code)"
    $button.AccessibleName = $button.Text
    $button.Size = New-Object System.Drawing.Size(145, 48)
    $button.Location = New-Object System.Drawing.Point($(if ($label -eq 'North') { 24 } else { 192 }), 95)
    $choice = $label
    $button.Add_Click({
      $script:count += 1
      $status.Text = "Selected $choice; selections $script:count"
      $status.AccessibleName = $status.Text
    }.GetNewClosure())
    $form.Controls.Add($button)
  }
  [void]$form.ShowDialog()
  return
}

$desktop = DesktopNames
if ($desktop.thread -ne 'Default' -or $desktop.input -ne 'Default') { throw 'Benchmark probe is not on the interactive input desktop' }
$window = Window
$element = [System.Windows.Automation.AutomationElement]::FromHandle($window.handle)
if (-not $element -or $element.Current.Name -ne $title) { throw 'Benchmark window UI Automation identity changed' }
$items = $element.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$names = @()
foreach ($item in $items) {
  $name = $item.Current.Name
  if (-not [string]::IsNullOrWhiteSpace($name)) { $names += $name }
}
$process = [System.Diagnostics.Process]::GetProcessById($window.pid)
$path = $process.MainModule.FileName
if ($Mode -eq 'interrupt') {
  if ([System.IO.File]::Exists((Join-Path $root 'interrupt.json'))) { throw 'The interruption already ran' }
  if ([RayaRecoveryWindow]::GetForegroundWindow() -ne $window.handle) { throw 'The benchmark window is not foreground for external interruption' }
  if ($names -notcontains 'Pending; selections 0') { throw 'The window already has an effect' }
  $targetX = $window.x + 137
  $targetY = $window.y + 91
  $targetWidth = $window.width + 115
  $targetHeight = $window.height + 83
  if (-not [RayaRecoveryWindow]::SetWindowPos($window.handle, [IntPtr]::Zero, $targetX, $targetY, $targetWidth, $targetHeight, 0x0014)) {
    throw 'External move and resize failed'
  }
  $after = Window
  if ($after.x -ne $targetX -or $after.y -ne $targetY -or $after.width -ne $targetWidth -or $after.height -ne $targetHeight) {
    throw 'External move and resize was not confirmed'
  }
  $row = [ordered]@{ runId = $data.runId; pid = $window.pid; before = @($window.x, $window.y, $window.width, $window.height); after = @($after.x, $after.y, $after.width, $after.height); at = [DateTimeOffset]::UtcNow.ToString('o') }
  $json = ConvertTo-Json -InputObject $row -Compress
  $stream = [System.IO.File]::Open((Join-Path $root 'interrupt.json'), [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write)
  try {
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($json)
    $stream.Write($bytes, 0, $bytes.Length)
  } finally { $stream.Dispose() }
}

[pscustomobject]@{
  threadDesktop = $desktop.thread
  inputDesktop = $desktop.input
  title = $element.Current.Name
  pid = $window.pid
  processPath = $path
  foreground = [RayaRecoveryWindow]::GetForegroundWindow() -eq $window.handle
  bounds = @($window.x, $window.y, $window.width, $window.height)
  names = $names
} | ConvertTo-Json -Compress -Depth 5
