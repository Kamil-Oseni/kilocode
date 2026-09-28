param([string] $Output = (Join-Path $PSScriptRoot '..\..\native\kilocode\bin\raya-process-host.exe'))
$ErrorActionPreference = 'Stop'
$vcvars = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path -LiteralPath $vcvars)) { throw 'MSVC BuildTools vcvars64.bat is required' }
$source = Join-Path $PSScriptRoot '..\..\native\kilocode\process-host.cpp'
$object = Join-Path $env:TEMP ('raya-process-host-{0}.obj' -f [guid]::NewGuid().ToString('N'))
$Output = [IO.Path]::GetFullPath($Output)
$symbol = [IO.Path]::ChangeExtension($Output, '.pdb')
New-Item -ItemType Directory -Path (Split-Path -Parent $Output) -Force | Out-Null
Remove-Item -LiteralPath $Output -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $symbol -Force -ErrorAction SilentlyContinue
$ready = $false
try {
  $command = '"{0}" >nul && cl /nologo /std:c++20 /EHsc /O2 /Z7 /W4 /WX /Zc:__cplusplus /Fo:"{1}" /Fe:"{2}" "{3}" crypt32.lib bcrypt.lib /link /DEBUG:FULL /INCREMENTAL:NO /PDB:"{4}"' -f $vcvars, $object, $Output, $source, $symbol
  & cmd.exe /s /c $command
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $Output)) { throw 'Native process host compilation failed' }
  if (-not (Test-Path -LiteralPath $symbol)) { throw 'Native process host symbols were not produced' }
  & $Output --self-test
  if ($LASTEXITCODE -ne 0) { throw 'Native process host self-test failed' }
  $protocol = & $Output --protocol | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or $protocol.version -ne 1 -or $protocol.proof -ne 'windows-job' -or $protocol.architecture -ne 'x64') { throw 'Native process host protocol mismatch' }
  $ready = $true
  Write-Output $Output
} finally {
  Remove-Item -LiteralPath $object -Force -ErrorAction SilentlyContinue
  if (-not $ready) {
    Remove-Item -LiteralPath $Output -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $symbol -Force -ErrorAction SilentlyContinue
  }
}
