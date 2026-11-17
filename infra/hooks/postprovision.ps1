. (Join-Path $PSScriptRoot 'common.ps1')
$settings = Get-DeploymentSettings
Assert-DeploymentConfiguration $settings
$null = Assert-AzureContext $settings.tenantId (Get-Setting 'AZURE_SUBSCRIPTION_ID')
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$outputs = Get-OutputEnvironment
Write-DemoIds -Root $root -Outputs $outputs
Initialize-ContentUnderstanding -Root $root -Settings $settings -Outputs $outputs
Write-Host 'Deployment outputs saved to demo-ids.local.json; the existing domain block was preserved. azd deploy must finish before using the application.'
