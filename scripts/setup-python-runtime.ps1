# Copy Python runtime from local installation for bundling
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/setup-python-runtime.ps1
param(
    [string]$Source = "C:\Python314",
    [string]$PythonExe = "python"
)

$ErrorActionPreference = "Stop"
$rootDir = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $rootDir "vendor\python-runtime"

# Detect Python location from executable
if (-not (Test-Path $Source)) {
    # Try venv Python first, then system Python
    $venvPython = Join-Path $rootDir ".venv\Scripts\python.exe"
    if (Test-Path $venvPython) {
        $PythonExe = $venvPython
        Write-Host "[python-runtime] Using venv Python: $PythonExe"
    }
    Write-Host "[python-runtime] $Source not found, detecting from $PythonExe ..."
    try {
        $pyPath = & $PythonExe -c "import sys; print(sys.base_prefix)"
        if ($pyPath) {
            $Source = $pyPath.Trim()
            Write-Host "[python-runtime] Detected Python at: $Source"
        }
    } catch {
        Write-Error "Cannot locate Python installation"
        exit 1
    }
}

if (-not (Test-Path $Source)) {
    Write-Error "Python installation not found at: $Source"
    exit 1
}

Write-Host "[python-runtime] Copying Python runtime from $Source ..."

# Clean target
if (Test-Path $runtimeDir) {
    Remove-Item $runtimeDir -Recurse -Force
}

# Copy Python runtime (exclude site-packages, since vendor/python has our deps)
$excludeDirs = @('Lib\site-packages', 'Lib\test', 'Lib\turtledemo', 'Scripts', 'Doc', 'Tools', '__pycache__')

$robocopyArgs = @($Source, $runtimeDir, '/E', '/NP', '/NFL', '/NDL', '/XD') + $excludeDirs + @('/XF', '*.pyc', '*.pyo', '*.pdb', '/NJH', '/NJS')
& robocopy @robocopyArgs

# robocopy exit codes: 0=success, 1=success, 2=success, 3=success+errors, 4-7=some failures
if ($LASTEXITCODE -ge 8) {
    Write-Error "robocopy failed with exit code $LASTEXITCODE"
    exit 1
}

# Clean up __pycache__ directories that might have been copied
Get-ChildItem $runtimeDir -Recurse -Directory -Filter '__pycache__' -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

# Remove embeddable ._pth file if present (we use PYTHONHOME, not embeddable mode)
Remove-Item (Join-Path $runtimeDir "python*._pth") -Force -ErrorAction SilentlyContinue

# Create empty site-packages (Python startup may need this dir to exist)
$spDir = Join-Path $runtimeDir "Lib\site-packages"
if (-not (Test-Path $spDir)) {
    New-Item -ItemType Directory -Path $spDir -Force | Out-Null
}

Write-Host "[python-runtime] Copy complete."

# Verify
$pythonExe = Join-Path $runtimeDir "python.exe"
Write-Host "[python-runtime] Verifying Python runtime..."
$ver = & $pythonExe --version
Write-Host "[python-runtime] $ver"
Write-Host "[python-runtime] Setup complete!"
