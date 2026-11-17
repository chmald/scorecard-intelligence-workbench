. (Join-Path $PSScriptRoot 'common.ps1')
$settings = Get-DeploymentSettings
Assert-DeploymentConfiguration $settings
$null = Assert-AzureContext $settings.tenantId (Get-Setting 'AZURE_SUBSCRIPTION_ID')
Assert-NoSoftDeletedResources $settings (Get-Setting 'AZURE_SUBSCRIPTION_ID')
Write-Host 'Explicit tenant/subscription and sign-in configuration verified. Model capacity and deployment permissions remain prerequisites.'
