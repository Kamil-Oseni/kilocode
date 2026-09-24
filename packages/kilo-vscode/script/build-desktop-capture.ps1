param(
  [string] $Output = (Join-Path $env:TEMP 'raya-desktop-capture.exe')
)

$ErrorActionPreference = 'Stop'
$vcvars = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path -LiteralPath $vcvars)) { throw 'MSVC BuildTools vcvars64.bat is required' }
$source = Join-Path $PSScriptRoot '..\native\desktop-capture.cpp'
$object = Join-Path $env:TEMP 'raya-desktop-capture.obj'
$command = '"{0}" >nul && cl /nologo /std:c++20 /EHsc /O2 /W4 /Zc:__cplusplus /Fo:"{1}" /Fe:"{2}" "{3}" d3d11.lib dxgi.lib windowscodecs.lib ole32.lib user32.lib' -f $vcvars, $object, $Output, $source
& cmd.exe /s /c $command
if ($LASTEXITCODE -ne 0) { throw "Desktop capture host compile failed with exit code $LASTEXITCODE" }
Write-Output $Output
