# MusePi installer for Windows — redirects to npm.
#
#   irm https://muselinn.github.io/MusePi/install.ps1 | iex

Write-Host ""
Write-Host "MusePi is installed via npm (requires Node.js 22+):" -ForegroundColor Cyan
Write-Host ""
Write-Host "  npm install -g @musepi/coding-agent" -ForegroundColor White
Write-Host "  musepi --version" -ForegroundColor White
Write-Host ""
Write-Host "Or run directly:" -ForegroundColor Cyan
Write-Host ""
Write-Host "  npx @musepi/coding-agent" -ForegroundColor White
Write-Host ""
Write-Host "See https://github.com/MuseLinn/MusePi for details." -ForegroundColor Gray
Write-Host ""
