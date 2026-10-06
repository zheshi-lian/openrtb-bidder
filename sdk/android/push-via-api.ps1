# Upload the whole SDK project to GitHub via the Contents API (bypasses blocked git protocol).
# Usage: run  .\push-via-api.ps1  from this directory (sdk/android).
$owner = "zheshi-lian"
$repo  = "Applink_ADX_Android"
$branch = "main"
$base  = Split-Path -Parent $MyInvocation.MyCommand.Path

# Non-interactive: if GH_PAT env var is set, reuse it instead of prompting (for automated upload).
if ($env:GH_PAT) { $token = $env:GH_PAT }
else { $token = Read-Host -Prompt "Paste your GitHub PAT (ghp_...)" }
$headers = @{
    Authorization = "Bearer $token"
    Accept        = "application/vnd.github+json"
}

# Get latest commit sha on the branch (needed to update existing files).
$ref = Invoke-RestMethod "https://api.github.com/repos/$owner/$repo/git/refs/heads/$branch" -Headers $headers
Write-Host "branch $branch HEAD: $($ref.object.sha)"

# Collect files: exclude .git / build / this script / prebuilt artifacts / secrets.
# NOTE: do NOT upload the prebuilt applink-adsdk-release.aar. After the source push, CI
# (android-release.yml) rebuilds the AAR in the cloud, so the AAR on GitHub always matches
# the source (no stale/inconsistent binary).
$files = Get-ChildItem -Path $base -Recurse -File | Where-Object {
    $_.FullName -notmatch '[\\/]\.git[\\/]' -and
    $_.FullName -notmatch '[\\/]build[\\/]' -and
    $_.FullName -notmatch '\.aar$' -and
    $_.FullName -notmatch '\.keystore$' -and
    $_.FullName -notmatch '\.jks$' -and
    $_.Name -ne 'push-via-api.ps1' -and
    $_.Name -ne 'local.properties' -and
    $_.Name -ne '.DS_Store'
}
# Sort: upload non-.github files first, then .github/workflows last (build triggers after source is in place).
$files = $files | Sort-Object { ($_.FullName -match '[\\/]\.github[\\/]') }, FullName

$ok = 0; $fail = 0
foreach ($f in $files) {
    $rel  = $f.FullName.Substring($base.Length + 1) -replace '\\', '/'
    $b64  = [Convert]::ToBase64String([IO.File]::ReadAllBytes($f.FullName))
    $url  = "https://api.github.com/repos/$owner/$repo/contents/$rel"

    $body = @{ message = "chore: add $rel"; content = $b64; branch = $branch }
    try {
        $existing = Invoke-RestMethod $url -Headers $headers
        $body.sha = $existing.sha   # exists -> update
    } catch { }                     # not exists -> create

    try {
        Invoke-RestMethod -Method PUT $url -Headers $headers -Body ($body | ConvertTo-Json) -ContentType "application/json"
        Write-Host "OK   $rel"
        $ok++
    } catch {
        Write-Host "FAIL $rel -> $_"
        $fail++
    }
}
Write-Host ""
Write-Host "Done: $ok succeeded, $fail failed"
if ($fail -eq 0) { Write-Host "Go to the repo Actions tab to watch the build (last uploaded file is .github/workflows/android-release.yml, which triggers the first build)" }
