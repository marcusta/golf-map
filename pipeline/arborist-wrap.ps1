# The file wrapper of Arborist's course data (arboristdata.dat, arborist_postprocess.dat):
#   IV (16 bytes) || AES-CBC( int32 length of the JSON || GZip(UTF-8 JSON) )
# decode: .dat -> JSON text file.  encode: JSON text file -> .dat (random IV).
# The 16-byte key is not in the repo: -KeyFile names a local copy (pipeline/arborist.py finds it).
param(
    [Parameter(Mandatory = $true)][ValidateSet('decode', 'encode')][string]$Mode,
    [Parameter(Mandatory = $true)][string]$In,
    [Parameter(Mandatory = $true)][string]$Out,
    [Parameter(Mandatory = $true)][string]$KeyFile
)
$ErrorActionPreference = 'Stop'
$key = [IO.File]::ReadAllBytes($KeyFile)
if ($key.Length -ne 16) { throw "Key file must hold 16 bytes, has $($key.Length)." }
$aes = [Security.Cryptography.Aes]::Create()
$aes.Mode = [Security.Cryptography.CipherMode]::CBC
$aes.Padding = [Security.Cryptography.PaddingMode]::PKCS7
$aes.Key = $key
if ($Mode -eq 'decode') {
    $data = [IO.File]::ReadAllBytes($In)
    $aes.IV = $data[0..15]
    $plain = $aes.CreateDecryptor().TransformFinalBlock($data, 16, $data.Length - 16)
    $length = [BitConverter]::ToInt32($plain, 0)
    $source = New-Object IO.MemoryStream(, $plain)
    $source.Position = 4
    $gzip = New-Object IO.Compression.GZipStream($source, [IO.Compression.CompressionMode]::Decompress)
    $text = New-Object IO.MemoryStream
    $gzip.CopyTo($text)
    if ($text.Length -ne $length) { throw "Declared length $length, got $($text.Length)." }
    [IO.File]::WriteAllBytes($Out, $text.ToArray())
}
else {
    $json = [IO.File]::ReadAllBytes($In)
    if ($json.Length -ge 3 -and $json[0] -eq 0xEF -and $json[1] -eq 0xBB -and $json[2] -eq 0xBF) { $json = $json[3..($json.Length - 1)] }
    $packed = New-Object IO.MemoryStream
    $packed.Write([BitConverter]::GetBytes([int]$json.Length), 0, 4)
    $gzip = New-Object IO.Compression.GZipStream($packed, [IO.Compression.CompressionMode]::Compress, $true)
    $gzip.Write($json, 0, $json.Length)
    $gzip.Dispose()
    $plain = $packed.ToArray()
    $aes.GenerateIV()
    $cipher = $aes.CreateEncryptor().TransformFinalBlock($plain, 0, $plain.Length)
    $result = New-Object IO.MemoryStream
    $result.Write($aes.IV, 0, 16)
    $result.Write($cipher, 0, $cipher.Length)
    [IO.File]::WriteAllBytes($Out, $result.ToArray())
}
