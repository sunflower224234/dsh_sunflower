# Build DeepSeek Harness desktop icon from a source PNG.
# Produces a maximally-compatible multi-resolution .ico (16/32/48/64/256)
# using BMP (DIB) entries for the small sizes — guaranteed to render in
# Explorer, taskbar and the shortcut property sheet. 256 is also DIB for
# uniformity.
#
# Source art lives in assets/ (icon-src.png).  The script also derives
# splash.png (the 256px rounded app tile used by the titlebar and the
# startup screen) from the same artwork, so both stay in sync.
#
# Usage:  powershell -ExecutionPolicy Bypass -File make-icon.ps1 [-SourcePng <path>]
param(
  [string]$SourcePng = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
# Default to the bundled source art (avoids hard-coding a non-ASCII filename).
if (-not $SourcePng) {
  $SourcePng = Join-Path $root 'assets\icon-src.png'
  if (-not (Test-Path $SourcePng)) {
    # Legacy fallback: newest PNG in the project dir.
    $SourcePng = Get-ChildItem $root -Filter *.png |
      Where-Object { $_.Name -notlike '.icon-tmp*' } |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1 -ExpandProperty FullName
  }
}
if (-not $SourcePng -or -not (Test-Path $SourcePng)) { throw "source image not found: $SourcePng" }

$src = [System.Drawing.Image]::FromFile($SourcePng)

# Render one size to a bottom-up 32bpp DIB (BMP) entry: 40-byte BITMAPINFOHEADER
# + XOR BGRA pixels + 1bpp AND mask (all zeros; alpha carries transparency).
function New-DibEntry([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $g.DrawImage($src, 0, 0, $size, $size)
  $g.Dispose()

  $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $stride = [Math]::Abs($data.Stride)
  $bytes = New-Object byte[] ($stride * $size)
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
  $bmp.UnlockBits($data)
  $bmp.Dispose()

  # Flip to bottom-up rows for the DIB XOR bitmap.
  $xor = New-Object byte[] ($stride * $size)
  for ($y = 0; $y -lt $size; $y++) {
    [Array]::Copy($bytes, $y * $stride, $xor, ($size - 1 - $y) * $stride, $stride)
  }

  # AND mask: 1bpp, each row padded to a 4-byte boundary; all zeros (alpha governs).
  $andRow = [int]([Math]::Ceiling($size / 32.0) * 4)
  $and = New-Object byte[] ($andRow * $size)

  # BITMAPINFOHEADER (40 bytes)
  $h = New-Object byte[] 40
  [BitConverter]::GetBytes([uint32]40).CopyTo($h, 0)              # biSize
  [BitConverter]::GetBytes([int]$size).CopyTo($h, 4)              # biWidth
  [BitConverter]::GetBytes([int]($size * 2)).CopyTo($h, 8)        # biHeight (XOR+AND)
  [BitConverter]::GetBytes([uint16]1).CopyTo($h, 12)              # biPlanes
  [BitConverter]::GetBytes([uint16]32).CopyTo($h, 14)             # biBitCount
  [BitConverter]::GetBytes([uint32]0).CopyTo($h, 16)              # biCompression
  [BitConverter]::GetBytes([uint32]($size * $size * 4)).CopyTo($h, 20) # biSizeImage
  [BitConverter]::GetBytes([int]0).CopyTo($h, 24)                 # biXPelsPerMeter
  [BitConverter]::GetBytes([int]0).CopyTo($h, 28)                 # biYPelsPerMeter
  [BitConverter]::GetBytes([uint32]0).CopyTo($h, 32)              # biClrUsed
  [BitConverter]::GetBytes([uint32]0).CopyTo($h, 36)              # biClrImportant

  $ms = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($ms)
  $bw.Write($h); $bw.Write($xor); $bw.Write($and)
  $bw.Flush()
  $bytes2 = $ms.ToArray()
  $bw.Dispose(); $ms.Dispose()
  # Leading comma stops PowerShell from unrolling the byte[] into Object[].
  return ,$bytes2
}

$sizes = 256, 64, 48, 32, 16
$data = @()
foreach ($s in $sizes) { $data += ,(New-DibEntry $s) }
$src.Dispose()

# Assemble ICO.
$entryCount = $sizes.Count
$headerSize = 6 + 16 * $entryCount
$entries = @()
$offset = $headerSize
for ($i = 0; $i -lt $entryCount; $i++) {
  $s = $sizes[$i]
  $bytes = $data[$i]
  $w = if ($s -eq 256) { 0 } else { $s }
  $entries += [pscustomobject]@{ w = $w; size = $bytes.Length; offset = $offset }
  $offset += $bytes.Length
}
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter($ms)
$bw.Write([uint16]0)          # reserved
$bw.Write([uint16]1)          # type: icon
$bw.Write([uint16]$entryCount)
foreach ($e in $entries) {
  $bw.Write([byte]$e.w)       # width (0 = 256)
  $bw.Write([byte]$e.w)       # height
  $bw.Write([byte]0)          # palette
  $bw.Write([byte]0)          # reserved
  $bw.Write([uint16]1)        # planes
  $bw.Write([uint16]32)       # bpp
  $bw.Write([uint32]$e.size)
  $bw.Write([uint32]$e.offset)
}
foreach ($i in 0..($entryCount - 1)) { $bw.Write($data[$i]) }
$bw.Flush()
$ico = $ms.ToArray()
$bw.Dispose(); $ms.Dispose()

$outIco = Join-Path $root 'icon.ico'
[System.IO.File]::WriteAllBytes($outIco, $ico)

$len = (Get-Item $outIco).Length
if ($len -lt 1000) { throw "icon.ico too small ($len bytes), generation failed" }
Write-Output "icon.ico OK: $len bytes"

# ---------------------------------------------------------------------------
# splash.png — 256px rounded app tile (face crop) for the titlebar brand mark
# and the startup screen logo.  Cropping to the head keeps the mark legible at
# 24px, where the full artwork (wordmark included) turns to mush.
# ---------------------------------------------------------------------------
Add-Type -AssemblyName System.Drawing
$splash = Join-Path $root 'splash.png'
$srcArt = [System.Drawing.Image]::FromFile($SourcePng)
$w = $srcArt.Width; $h = $srcArt.Height

# Face crop: horizontal centre, upper-middle band of the artwork.  Clamped square.
$crop = [int][Math]::Round([Math]::Min($w, $h * 0.62))
$cropX = [int][Math]::Round(($w - $crop) / 2)
$cropY = [int][Math]::Round(($h - $crop) / 3)

$outSize = 256
$pad = [int][Math]::Round($outSize * 0.06)   # breathing room inside the tile
$inner = $outSize - 2 * $pad
$radius = [int][Math]::Round($outSize * 0.22) # matches the artwork's rounded-square

$tile = New-Object System.Drawing.Bitmap($outSize, $outSize, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($tile)
$g.Clear([System.Drawing.Color]::Transparent)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

# Rounded-rect clip path.
$d = 2 * $radius
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc($pad, $pad, $d, $d, 180, 90)
$path.AddArc($pad + $inner - $d, $pad, $d, $d, 270, 90)
$path.AddArc($pad + $inner - $d, $pad + $inner - $d, $d, $d, 0, 90)
$path.AddArc($pad, $pad + $inner - $d, $d, $d, 90, 90)
$path.CloseFigure()
$g.SetClip($path)
$g.DrawImage($srcArt, (New-Object System.Drawing.Rectangle($pad, $pad, $inner, $inner)),
  $cropX, $cropY, $crop, $crop, [System.Drawing.GraphicsUnit]::Pixel)
$g.ResetClip()
$g.Dispose(); $path.Dispose()
$tile.Save($splash, [System.Drawing.Imaging.ImageFormat]::Png)
$tile.Dispose(); $srcArt.Dispose()
Write-Output "splash.png OK: $((Get-Item $splash).Length) bytes"