param([Parameter(Mandatory = $true)][string]$Task)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

$root = [System.IO.Path]::GetFullPath($Task)
$manifest = Join-Path $root 'task.json'
$journal = Join-Path $root 'decision.jsonl'
$data = [System.IO.File]::ReadAllText($manifest, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
if ($data.format -ne 'raya.installed-dialog-task' -or $data.version -ne 1 -or $data.scenario -ne 'dialog-handling') {
  throw 'Invalid dialog task manifest'
}
if ([System.IO.File]::Exists($journal)) {
  throw 'The dialog has already produced a decision'
}

$title = "Raya dialog benchmark $($data.code)"
$prompt = "Save draft $($data.code)? Choose Yes or No."
$choice = [System.Windows.Forms.MessageBox]::Show(
  $prompt,
  $title,
  [System.Windows.Forms.MessageBoxButtons]::YesNo,
  [System.Windows.Forms.MessageBoxIcon]::Question
)
$row = [ordered]@{
  runId = $data.runId
  code = $data.code
  choice = $choice.ToString()
  dialog = 'native-winforms-messagebox-v1'
}
$line = (ConvertTo-Json -InputObject $row -Compress) + "`n"
$bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($line)
$stream = [System.IO.File]::Open($journal, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write)
try {
  $stream.Write($bytes, 0, $bytes.Length)
} finally {
  $stream.Dispose()
}
