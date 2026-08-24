# build-standalone.ps1
#
# Bundles the site-wide assets (css/style.css, css/uploader.css,
# js/theme.js, js/reveal.js) directly into firmware/uploader.html so the
# flasher only depends on files inside the firmware/ folder.
#
# Run from anywhere:
#     powershell -ExecutionPolicy Bypass -File firmware/build-standalone.ps1
#
# Source of truth is firmware/uploader.template.html; the generated file is
# firmware/uploader.html. Re-run this script whenever the template or any of
# the site css/js files change.

$ErrorActionPreference = 'Stop'

$firmware = $PSScriptRoot
$root     = Split-Path $PSScriptRoot -Parent

$templatePath = Join-Path $firmware 'uploader.template.html'
$outputPath   = Join-Path $firmware 'uploader.html'

$utf8 = [System.Text.Encoding]::UTF8

$styleCss    = [System.IO.File]::ReadAllText((Join-Path $root 'css\style.css'), $utf8)
$uploaderCss = [System.IO.File]::ReadAllText((Join-Path $root 'css\uploader.css'), $utf8)
$themeJs     = [System.IO.File]::ReadAllText((Join-Path $root 'js\theme.js'), $utf8)
$revealJs    = [System.IO.File]::ReadAllText((Join-Path $root 'js\reveal.js'), $utf8)

$html = [System.IO.File]::ReadAllText($templatePath, $utf8)

# CSS: style.css first (shared design system), then uploader.css (page styles).
$cssText = $styleCss.TrimEnd() + "`n`n" + $uploaderCss.TrimEnd()
$html = $html.Replace('@@CSS@@', $cssText)
$html = $html.Replace('@@THEME_JS@@', $themeJs.TrimEnd())
$html = $html.Replace('@@REVEAL_JS@@', $revealJs.TrimEnd())

if ($html -match '@@(CSS|THEME_JS|REVEAL_JS)@@') {
  throw 'Not all placeholders were replaced. Check the template file.'
}

# Make sure no site-wide references leaked into the generated page.
$leaks = @('\.\./css/', '\.\./js/')
foreach ($pattern in $leaks) {
  if ($html -match $pattern) {
    throw "The generated page still references a site-wide asset ($pattern) - refusing to write."
  }
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($outputPath, $html, $utf8NoBom)

$sizeKb = [math]::Round($html.Length / 1KB)
Write-Host "OK: wrote $outputPath ($sizeKb KB)." -ForegroundColor Green