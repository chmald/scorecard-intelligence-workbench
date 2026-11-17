. (Join-Path $PSScriptRoot 'bootstrap.ps1')
$null = Initialize-WorkbenchDeployment -PersistAzd
Write-Host 'Deployment target and sign-in configuration are ready. Cloud extraction and answers are enabled unless explicitly disabled.'
