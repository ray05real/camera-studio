# Draws the app icon (a camera lens with a red record dot) for the iPhone app, the PC page and the PC shortcut.
# Run its lines in PowerShell from the project folder (Windows blocks running .ps1 files by default).
Add-Type -AssemblyName System.Drawing
$root = if ($PSScriptRoot) { Split-Path -Parent $PSScriptRoot } else { (Get-Location).Path }

function Draw-Icon([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.InterpolationMode = 'HighQualityBicubic'
    $s = $size / 1024.0
    $full = New-Object System.Drawing.Rectangle 0, 0, $size, $size
    $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush $full, ([System.Drawing.Color]::FromArgb(255, 38, 30, 52)), ([System.Drawing.Color]::FromArgb(255, 12, 10, 18)), 90
    $g.FillRectangle($bg, $full)

    # lens barrel: a silver ring
    $cx = 512 * $s; $cy = 548 * $s
    $r1 = 318 * $s
    $ringRect = New-Object System.Drawing.RectangleF ($cx - $r1), ($cy - $r1), (2 * $r1), (2 * $r1)
    $ring = New-Object System.Drawing.Drawing2D.LinearGradientBrush $ringRect, ([System.Drawing.Color]::FromArgb(255, 236, 236, 244)), ([System.Drawing.Color]::FromArgb(255, 112, 108, 128)), 60
    $g.FillEllipse($ring, $ringRect)
    # dark body inside the ring
    $r2 = 262 * $s
    $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 14, 12, 20))), ($cx - $r2), ($cy - $r2), (2 * $r2), (2 * $r2))
    # glass: deep blue-violet
    $r3 = 196 * $s
    $glassRect = New-Object System.Drawing.RectangleF ($cx - $r3), ($cy - $r3), (2 * $r3), (2 * $r3)
    $glass = New-Object System.Drawing.Drawing2D.LinearGradientBrush $glassRect, ([System.Drawing.Color]::FromArgb(255, 70, 66, 150)), ([System.Drawing.Color]::FromArgb(255, 10, 10, 28)), 45
    $g.FillEllipse($glass, $glassRect)
    $r4 = 92 * $s
    $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 6, 6, 14))), ($cx - $r4), ($cy - $r4), (2 * $r4), (2 * $r4))
    # reflection
    $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(150, 255, 255, 255))), ($cx - 120 * $s), ($cy - 132 * $s), (70 * $s), (52 * $s))
    $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(90, 255, 255, 255))), ($cx + 60 * $s), ($cy + 70 * $s), (34 * $s), (26 * $s))

    # record dot, top right, with a dark gap round it
    $dx = 800 * $s; $dy = 226 * $s
    $gap = 98 * $s
    $g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 22, 18, 30))), ($dx - $gap), ($dy - $gap), (2 * $gap), (2 * $gap))
    $rd = 74 * $s
    $dotRect = New-Object System.Drawing.RectangleF ($dx - $rd), ($dy - $rd), (2 * $rd), (2 * $rd)
    $dot = New-Object System.Drawing.Drawing2D.LinearGradientBrush $dotRect, ([System.Drawing.Color]::FromArgb(255, 255, 92, 92)), ([System.Drawing.Color]::FromArgb(255, 214, 20, 40)), 90
    $g.FillEllipse($dot, $dotRect)
    $g.Dispose()
    return $bmp
}

$icon = Draw-Icon 1024
$icon.Save((Join-Path $root 'ios\App\Assets.xcassets\AppIcon.appiconset\AppIcon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$icon.Dispose()

$small = Draw-Icon 256
$small.Save((Join-Path $root 'pc\ui\icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)

# A Windows .ico (one 256 px PNG inside) for the desktop shortcut.
$ms = New-Object System.IO.MemoryStream
$small.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$png = $ms.ToArray()
$small.Dispose()
$out = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $out
$w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]1)
$w.Write([byte]0); $w.Write([byte]0); $w.Write([byte]0); $w.Write([byte]0)
$w.Write([UInt16]1); $w.Write([UInt16]32); $w.Write([UInt32]$png.Length); $w.Write([UInt32]22)
$w.Write($png)
[System.IO.File]::WriteAllBytes((Join-Path $root 'pc\ui\icon.ico'), $out.ToArray())
"Icons written."
