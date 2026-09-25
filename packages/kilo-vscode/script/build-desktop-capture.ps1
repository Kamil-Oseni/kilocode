param(
  [string] $Output = (Join-Path $env:TEMP 'raya-desktop-capture.exe')
)

$ErrorActionPreference = 'Stop'
$vcvars = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path -LiteralPath $vcvars)) { throw 'MSVC BuildTools vcvars64.bat is required' }
$source = Join-Path $PSScriptRoot '..\native\desktop-capture.cpp'
$object = Join-Path $env:TEMP ('raya-desktop-capture-{0}.obj' -f [guid]::NewGuid().ToString('N'))
$Output = [IO.Path]::GetFullPath($Output)
$symbol = [IO.Path]::ChangeExtension($Output, '.pdb')
$cache = [IO.Path]::ChangeExtension($Output, '.ilk')
$dir = Split-Path -Parent $Output
New-Item -ItemType Directory -Path $dir -Force | Out-Null
# Never let a failed build leave an older executable eligible for packaging.
Remove-Item -LiteralPath $Output -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $symbol -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $cache -Force -ErrorAction SilentlyContinue
$ready = $false
try {
  $command = '"{0}" >nul && cl /nologo /std:c++20 /EHsc /O2 /Z7 /W4 /Zc:__cplusplus /Fo:"{1}" /Fe:"{2}" "{3}" d3d11.lib dxgi.lib windowscodecs.lib ole32.lib user32.lib advapi32.lib /link /DEBUG:FULL /INCREMENTAL:NO /PDB:"{4}"' -f $vcvars, $object, $Output, $source, $symbol
  & cmd.exe /s /c $command
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $Output)) {
    throw "Desktop capture host compile failed with exit code $LASTEXITCODE"
  }
  if (-not (Test-Path -LiteralPath $symbol)) { throw 'Desktop capture host symbols were not produced' }
  & $Output --self-test
  if ($LASTEXITCODE -ne 0) { throw "Desktop capture host self-test failed with exit code $LASTEXITCODE" }
  $fault = Join-Path $env:TEMP ('raya-capture-build-fault-{0}.txt' -f [guid]::NewGuid().ToString('N'))
  $prior = [Environment]::GetEnvironmentVariable('RAYA_NATIVE_FAULT_RECEIPT', 'Process')
  try {
    $env:RAYA_NATIVE_FAULT_RECEIPT = $fault
    & $Output --fault-test > $null
    $value = if (Test-Path -LiteralPath $fault) { [IO.File]::ReadAllText($fault) } else { '' }
    if ($LASTEXITCODE -ne -1073741819 -or $value -notmatch '^C0000005:(main\+0x[0-9A-F]{16}|external\+0x0)\n$') {
      throw 'Desktop capture host fault receipt self-test failed'
    }
  } finally {
    if ($null -eq $prior) { Remove-Item Env:RAYA_NATIVE_FAULT_RECEIPT -ErrorAction SilentlyContinue }
    else { $env:RAYA_NATIVE_FAULT_RECEIPT = $prior }
    Remove-Item -LiteralPath $fault -Force -ErrorAction SilentlyContinue
  }
  $ready = $true
  Write-Output $Output
}
finally {
  Remove-Item -LiteralPath $object -Force -ErrorAction SilentlyContinue
  if (-not $ready) {
    Remove-Item -LiteralPath $Output -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $symbol -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $cache -Force -ErrorAction SilentlyContinue
  }
}
