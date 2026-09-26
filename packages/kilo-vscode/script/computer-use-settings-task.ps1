param([string]$Page)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class RayaSettingsWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
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

$handle = [RayaSettingsWindow]::GetForegroundWindow()
$windowPid = [uint32]0
[void][RayaSettingsWindow]::GetWindowThreadProcessId($handle, [ref]$windowPid)
$current = [RayaSettingsWindow]::Name([RayaSettingsWindow]::GetThreadDesktop([RayaSettingsWindow]::GetCurrentThreadId()))
$input = [RayaSettingsWindow]::OpenInputDesktop(0, $false, 0x0001)
try { $inputName = [RayaSettingsWindow]::Name($input) }
finally { if ($input -ne [IntPtr]::Zero) { [void][RayaSettingsWindow]::CloseDesktop($input) } }

$target = $false
$names = @()
$path = ''
if ($handle -ne [IntPtr]::Zero -and $windowPid -ne 0) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
  $items = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $seen = New-Object 'System.Collections.Generic.HashSet[int]'
  foreach ($item in @($root) + @($items)) {
    $info = $item.Current
    if ($info.ProcessId -le 0) { continue }
    if (-not $seen.Add($info.ProcessId)) { continue }
    $process = [System.Diagnostics.Process]::GetProcessById($info.ProcessId)
    try { $candidate = $process.MainModule.FileName } catch { continue }
    if ($candidate -notmatch '(?i)\\ImmersiveControlPanel\\SystemSettings\.exe$') { continue }
    $target = $true
    $path = $candidate
  }
  if ($target) {
    foreach ($item in $items) {
      $name = $item.Current.Name
      if (-not [string]::IsNullOrWhiteSpace($name)) { $names += $name }
    }
  }
}
[pscustomobject]@{
  page = $Page
  processPath = $path
  genuineSettings = $target
  foreground = $handle -ne [IntPtr]::Zero
  threadDesktop = $current
  inputDesktop = $inputName
  names = $names
} | ConvertTo-Json -Compress -Depth 4
