param(
  [ValidateRange(1, 1000)]
  [int] $Frames = 12
)

$ErrorActionPreference = 'Stop'
$vcvars = 'C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path -LiteralPath $vcvars)) { throw 'MSVC BuildTools vcvars64.bat is required' }

$source = Join-Path $PSScriptRoot 'computer-use-capture-bench.cpp'
$binary = Join-Path $env:TEMP 'raya-capture-bench.exe'
$object = Join-Path $env:TEMP 'raya-capture-bench.obj'
$command = '"{0}" >nul && cl /nologo /std:c++20 /EHsc /O2 /W4 /Zc:__cplusplus /Fo:"{1}" /Fe:"{2}" "{3}" d3d11.lib dxgi.lib user32.lib windowsapp.lib' -f $vcvars, $object, $binary, $source
& cmd.exe /s /c $command
if ($LASTEXITCODE -ne 0) { throw "Capture benchmark compile failed with exit code $LASTEXITCODE" }

& $binary $Frames
if ($LASTEXITCODE -ne 0) { throw "Capture benchmark failed with exit code $LASTEXITCODE" }
