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
$dir = Split-Path -Parent $Output
New-Item -ItemType Directory -Path $dir -Force | Out-Null
# Never let a failed build leave an older executable eligible for packaging.
Remove-Item -LiteralPath $Output -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $symbol -Force -ErrorAction SilentlyContinue
$ready = $false
try {
  $command = '"{0}" >nul && cl /nologo /std:c++20 /EHsc /O2 /Z7 /W4 /Zc:__cplusplus /Fo:"{1}" /Fe:"{2}" "{3}" d3d11.lib dxgi.lib windowscodecs.lib ole32.lib user32.lib /link /DEBUG:FULL /PDB:"{4}"' -f $vcvars, $object, $Output, $source, $symbol
  & cmd.exe /s /c $command
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $Output)) {
    throw "Desktop capture host compile failed with exit code $LASTEXITCODE"
  }
  if (-not (Test-Path -LiteralPath $symbol)) { throw 'Desktop capture host symbols were not produced' }
  & $Output --self-test
  if ($LASTEXITCODE -ne 0) { throw "Desktop capture host self-test failed with exit code $LASTEXITCODE" }
  $ready = $true
  Write-Output $Output
}
finally {
  Remove-Item -LiteralPath $object -Force -ErrorAction SilentlyContinue
  if (-not $ready) {
    Remove-Item -LiteralPath $Output -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $symbol -Force -ErrorAction SilentlyContinue
  }
}
