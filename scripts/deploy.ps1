[CmdletBinding()]
param(
    [string]$TenantId = $env:AZURE_TENANT_ID,
    [string]$SubscriptionId = $env:AZURE_SUBSCRIPTION_ID,
    [string]$EnvironmentName = $env:AZURE_ENV_NAME,
    [string]$Location = $env:AZURE_LOCATION,
    [string]$EntraAudience = $env:ENTRA_AUDIENCE,
    [string]$ResourceGroup = $env:AZURE_RESOURCE_GROUP,
    [switch]$Manual
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\infra\hooks\bootstrap.ps1')
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$env:AZURE_TENANT_ID = $TenantId
$env:AZURE_SUBSCRIPTION_ID = $SubscriptionId
$env:AZURE_ENV_NAME = $EnvironmentName
$env:AZURE_LOCATION = $Location
$env:ENTRA_AUDIENCE = $EntraAudience
$env:AZURE_RESOURCE_GROUP = $ResourceGroup
$settings = Initialize-WorkbenchDeployment
$TenantId = $settings.tenantId
$SubscriptionId = Get-Setting 'AZURE_SUBSCRIPTION_ID'
$EnvironmentName = $settings.environmentName
$Location = $settings.location
$null = Assert-AzureContext $TenantId $SubscriptionId
Assert-NoSoftDeletedResources $settings $SubscriptionId
Push-Location $root
try {
    if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules\@azure\identity'))) {
        & npm ci --no-fund --no-audit
        if ($LASTEXITCODE -ne 0) { throw 'Unable to install locked application dependencies.' }
    }
    if ($Manual) {
        . (Join-Path $root 'infra\deploy-manual.ps1')
        $outputs = Invoke-ManualDeployment -Settings $settings -SubscriptionId $SubscriptionId -Root $root
    } else {
        $parameters = [ordered]@{}
        foreach ($entry in $settings.GetEnumerator()) { $parameters[$entry.Key] = @{ value = $entry.Value } }
        $parameterFile = Join-Path $root 'infra\deploy.parameters.local.json'
        try {
            @{ '$schema' = 'https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#'; contentVersion = '1.0.0.0'; parameters = $parameters } |
                ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $parameterFile -Encoding utf8NoBOM
            $deployment = Invoke-AzJson -Arguments @('deployment', 'sub', 'create', '--subscription', $SubscriptionId, '--location', $Location,
                '--name', "workbench-$EnvironmentName", '--template-file', 'infra\azd.bicep', '--parameters', "@$parameterFile")
            $outputs = [ordered]@{}
            foreach ($entry in $deployment.properties.outputs.GetEnumerator()) { $outputs[$entry.Key] = $entry.Value.value }
            $tag = "app:$([DateTime]::UtcNow.ToString('yyyyMMddHHmmss'))"
            $null = Invoke-AzJson -Arguments @('acr', 'build', '--subscription', $SubscriptionId, '--registry', $outputs.AZURE_CONTAINER_REGISTRY_NAME,
                '--image', $tag, '--file', 'Dockerfile', '--no-logs', '.')
            $image = "$($outputs.AZURE_CONTAINER_REGISTRY_ENDPOINT)/$tag"
            $null = Invoke-AzJson -Arguments @('containerapp', 'update', '--subscription', $SubscriptionId,
                '--resource-group', $outputs.AZURE_RESOURCE_GROUP, '--name', $outputs.AZURE_CONTAINER_APP_NAME, '--image', $image)
        } finally {
            if (Test-Path $parameterFile) { Remove-Item -LiteralPath $parameterFile -Force }
        }
    }
    Write-DemoIds -Root $root -Outputs $outputs
    Complete-WorkbenchIdentity -Settings $settings -AppUrl $outputs.SERVICE_APP_ENDPOINT_URL
    Initialize-ContentUnderstanding -Root $root -Settings $settings -Outputs $outputs
    $health = Invoke-RestMethod -Uri "$($outputs.SERVICE_APP_ENDPOINT_URL)/health" -TimeoutSec 30
    if ($health.status -ne 'ok') { throw 'Application health check did not return status=ok.' }
    Write-Host "Application deployed: $($outputs.SERVICE_APP_ENDPOINT_URL)"
} finally { Pop-Location }
