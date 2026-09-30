# Grant "Create symbolic links" (SeCreateSymbolicLinkPrivilege) back to the
# current user.
#
# Why: Electron's ProcessSingleton lock file is a SYMLINK on Windows. Creating
# it requires the SeCreateSymbolicLinkPrivilege user right — NOT covered by
# Developer Mode (Chromium does not pass the unprivileged-create flag). When
# PC-manager "optimizer" software or a policy reset revokes the right, every
# Electron launch dies as exit code 3 with zero output; Node-as-Electron and
# plain file writes keep working, which makes the root cause look like a
# broken Electron build. It is not — the right assignment is gone.
#
# Usage: right-click this file → "Run with PowerShell" (or "Run as
# administrator"). Elevated privileges are required to edit the local security
# policy. After it completes, SIGN OUT AND BACK IN — user rights only enter
# new logon tokens, so already-running sessions keep failing until re-login.

#Requires -RunAsAdministrator
$ErrorActionPreference = "Stop"

$account = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$sid = (New-Object System.Security.Principal.NTAccount($account)).Translate(
	[System.Security.Principal.SecurityIdentifier]
).Value
$inf = Join-Path $env:TEMP "musepi-symlink-rights.inf"
$db = Join-Path $env:TEMP "musepi-symlink-rights.sdb"

secedit /export /cfg $inf /areas USER_RIGHTS | Out-Null

$lines = Get-Content $inf
$out = foreach ($line in $lines) {
	if ($line -match "^SeCreateSymbolicLinkPrivilege\s*=") {
		if ($line -notmatch [regex]::Escape($sid)) { "$line,*$sid" } else { $line }
	} else {
		$line
	}
}
# Key absent (right fully unassigned) — create it with just this user.
if (-not ($out | Where-Object { $_ -match "^SeCreateSymbolicLinkPrivilege\s*=" })) {
	$out += "SeCreateSymbolicLinkPrivilege = *$sid"
}
Set-Content -Path $inf -Value $out

secedit /configure /db $db /cfg $inf /areas USER_RIGHTS | Out-Null

Write-Host ""
Write-Host "Granted SeCreateSymbolicLinkPrivilege to $account ($sid)." -ForegroundColor Green
Write-Host ""
Write-Host "Now SIGN OUT and sign back in (or reboot): the privilege only reaches"
Write-Host "process tokens created after the policy change."
Write-Host ""
