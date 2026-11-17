Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-Setting {
    param([string]$Name, [string]$Default = '')
    $value = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrWhiteSpace($value)) { return $Default }
    return $value
}

function Get-BooleanSetting {
    param([string]$Name)
    $value = Get-Setting $Name 'false'
    if ($value -notin @('true', 'false')) { throw "$Name must be true or false." }
    return $value -eq 'true'
}

function Get-DeploymentSettings {
    $name = Get-Setting 'AZURE_ENV_NAME'
    return [ordered]@{
        environmentName = $name
        location = Get-Setting 'AZURE_LOCATION'
        tenantId = Get-Setting 'AZURE_TENANT_ID'
        entraAudience = Get-Setting 'ENTRA_AUDIENCE'
        entraClientId = Get-Setting 'ENTRA_CLIENT_ID'
        entraApiScope = Get-Setting 'ENTRA_API_SCOPE'
        containerImage = Get-Setting 'CONTAINER_IMAGE' 'mcr.microsoft.com/dotnet/samples:aspnetapp'
        cosmosDatabaseName = Get-Setting 'COSMOS_DATABASE' 'workbench'
        cosmosContainerName = Get-Setting 'COSMOS_CONTAINER' 'state'
        cosmosThroughput = [int](Get-Setting 'COSMOS_THROUGHPUT' '400')
        logRetentionDays = [int](Get-Setting 'LOG_RETENTION_DAYS' '30')
        deployContentUnderstanding = Get-BooleanSetting 'DEPLOY_CONTENT_UNDERSTANDING'
        contentUnderstandingLocation = Get-Setting 'CONTENT_UNDERSTANDING_LOCATION'
        contentUnderstandingAnalyzerId = Get-Setting 'CONTENT_UNDERSTANDING_ANALYZER_ID' 'document_metrics'
        contentUnderstandingCompletionModelName = Get-Setting 'CONTENT_UNDERSTANDING_COMPLETION_MODEL'
        contentUnderstandingCompletionModelVersion = Get-Setting 'CONTENT_UNDERSTANDING_COMPLETION_MODEL_VERSION'
        contentUnderstandingCompletionDeploymentName = Get-Setting 'CONTENT_UNDERSTANDING_COMPLETION_DEPLOYMENT'
        contentUnderstandingCompletionDeploymentSku = Get-Setting 'CONTENT_UNDERSTANDING_COMPLETION_DEPLOYMENT_SKU'
        contentUnderstandingCompletionCapacity = [int](Get-Setting 'CONTENT_UNDERSTANDING_COMPLETION_CAPACITY' '1')
        contentUnderstandingEmbeddingModelName = Get-Setting 'CONTENT_UNDERSTANDING_EMBEDDING_MODEL'
        contentUnderstandingEmbeddingModelVersion = Get-Setting 'CONTENT_UNDERSTANDING_EMBEDDING_MODEL_VERSION'
        contentUnderstandingEmbeddingDeploymentName = Get-Setting 'CONTENT_UNDERSTANDING_EMBEDDING_DEPLOYMENT'
        contentUnderstandingEmbeddingDeploymentSku = Get-Setting 'CONTENT_UNDERSTANDING_EMBEDDING_DEPLOYMENT_SKU'
        contentUnderstandingEmbeddingCapacity = [int](Get-Setting 'CONTENT_UNDERSTANDING_EMBEDDING_CAPACITY' '1')
        contentUnderstandingSetupPrincipalId = Get-Setting 'AZURE_PRINCIPAL_ID'
        contentUnderstandingSetupPrincipalType = Get-Setting 'AZURE_PRINCIPAL_TYPE' 'User'
        deployOpenAI = Get-BooleanSetting 'DEPLOY_OPENAI'
        openAILocation = Get-Setting 'AZURE_OPENAI_LOCATION'
        openAIModelName = Get-Setting 'AZURE_OPENAI_MODEL_NAME'
        openAIModelVersion = Get-Setting 'AZURE_OPENAI_MODEL_VERSION'
        openAIDeploymentName = Get-Setting 'AZURE_OPENAI_DEPLOYMENT'
        openAIDeploymentSku = Get-Setting 'AZURE_OPENAI_DEPLOYMENT_SKU'
        openAICapacity = [int](Get-Setting 'AZURE_OPENAI_CAPACITY' '1')
        resourceGroupName = Get-Setting 'AZURE_RESOURCE_GROUP' "rg-$name"
    }
}

function Assert-TargetIds {
    param([string]$TenantId, [string]$SubscriptionId)
    foreach ($entry in @{ AZURE_TENANT_ID = $TenantId; AZURE_SUBSCRIPTION_ID = $SubscriptionId }.GetEnumerator()) {
        $parsed = [guid]::Empty
        if (-not [guid]::TryParse($entry.Value, [ref]$parsed) -or $parsed -eq [guid]::Empty) {
            throw "$($entry.Key) must be an explicit, nonzero GUID."
        }
    }
    $fingerprint = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
        [Text.Encoding]::UTF8.GetBytes(([guid]$TenantId).ToString('D')))).ToLowerInvariant()
    if ($fingerprint -eq '2ae8f8066baab9e36c122f5eb5425f33ab2f5ffbea767ea5a7d9f82de680faec') {
        throw 'This organizational tenant is denied for demo deployment. Select an approved isolated demo tenant.'
    }
}

function Assert-DeploymentConfiguration {
    param([System.Collections.IDictionary]$Settings)
    if ($Settings.environmentName -cnotmatch '^[a-z][a-z0-9]{2,15}$') {
        throw 'AZURE_ENV_NAME must be 3-16 lowercase letters/digits, starting with a letter.'
    }
    Assert-TargetIds $Settings.tenantId (Get-Setting 'AZURE_SUBSCRIPTION_ID')
    if ([string]::IsNullOrWhiteSpace($Settings.location)) { throw 'AZURE_LOCATION must be explicit; verify service/model availability for your subscription.' }
    if ([string]::IsNullOrWhiteSpace($Settings.entraAudience)) {
        throw 'ENTRA_AUDIENCE is required. Configure an existing single-tenant app and reviewer, manager, auditor roles before deploying.'
    }
    foreach ($key in @('entraAudience', 'entraClientId')) {
        $parsed = [guid]::Empty
        if (-not [guid]::TryParse($Settings[$key], [ref]$parsed) -or $parsed -eq [guid]::Empty) {
            throw "$key must be an explicit, nonzero application client GUID. V2 API audiences are API application IDs, not Application ID URIs."
        }
    }
    $scopePrefix = "api://$($Settings.entraAudience)/"
    if (-not $Settings.entraApiScope.StartsWith($scopePrefix, [StringComparison]::OrdinalIgnoreCase) -or
        $Settings.entraApiScope.Substring($scopePrefix.Length) -notmatch '^[a-zA-Z][a-zA-Z0-9._-]{0,127}$') {
        throw 'ENTRA_API_SCOPE must be api://<ENTRA_AUDIENCE>/<delegated-scope-name>. Configure that exposed API scope and SPA consent; do not request Microsoft Graph scopes.'
    }
    if ($Settings.resourceGroupName -notmatch '^[a-zA-Z0-9_.()-]{1,90}$' -or $Settings.resourceGroupName.EndsWith('.')) {
        throw 'AZURE_RESOURCE_GROUP is not a valid resource group name.'
    }
    foreach ($key in @('cosmosDatabaseName', 'cosmosContainerName')) {
        if ($Settings[$key] -notmatch '^[a-zA-Z0-9_-]{1,128}$') { throw "$key must contain only letters, digits, underscore or hyphen." }
    }
    if ($Settings.cosmosThroughput -lt 400 -or $Settings.cosmosThroughput % 100 -ne 0) { throw 'COSMOS_THROUGHPUT must be a multiple of 100 and at least 400 RU/s.' }
    if ($Settings.logRetentionDays -lt 30 -or $Settings.logRetentionDays -gt 730) { throw 'LOG_RETENTION_DAYS must be 30-730.' }
    if ($Settings.openAICapacity -lt 1) { throw 'AZURE_OPENAI_CAPACITY must be positive.' }
    if ($Settings.deployContentUnderstanding) {
        foreach ($kind in @('Completion', 'Embedding')) {
            foreach ($field in @('ModelName', 'ModelVersion', 'DeploymentName', 'DeploymentSku')) {
                $key = "contentUnderstanding$kind$field"
                if ([string]::IsNullOrWhiteSpace($Settings[$key])) {
                    throw "DEPLOY_CONTENT_UNDERSTANDING=true requires explicit $key. Verify supported model/version/SKU in the selected region."
                }
            }
            if ($Settings["contentUnderstanding${kind}Capacity"] -lt 1) { throw "Content Understanding $kind capacity must be positive." }
            if ($Settings["contentUnderstanding${kind}DeploymentName"] -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$') {
                throw "Content Understanding $kind deployment name must be 1-64 letters, digits, dot, underscore or hyphen, starting with a letter or digit."
            }
        }
        if ($Settings.contentUnderstandingCompletionDeploymentName -eq $Settings.contentUnderstandingEmbeddingDeploymentName) {
            throw 'Content Understanding completion and embedding deployments must have different names.'
        }
        if ($Settings.contentUnderstandingCompletionModelName -eq $Settings.contentUnderstandingEmbeddingModelName) {
            throw 'Content Understanding completion and embedding models must have different names.'
        }
        if ($Settings.contentUnderstandingAnalyzerId -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$') {
            throw 'CONTENT_UNDERSTANDING_ANALYZER_ID must be 1-64 letters, digits, dot, underscore or hyphen, starting with a letter or digit.'
        }
        $principal = [guid]::Empty
        if (-not [guid]::TryParse($Settings.contentUnderstandingSetupPrincipalId, [ref]$principal) -or $principal -eq [guid]::Empty) {
            throw 'AZURE_PRINCIPAL_ID must be an explicit, nonzero setup principal GUID when Content Understanding is enabled.'
        }
        if ($Settings.contentUnderstandingSetupPrincipalType -cnotin @('User', 'ServicePrincipal', 'Group')) {
            throw 'AZURE_PRINCIPAL_TYPE must be User, ServicePrincipal or Group.'
        }
    }
    if ($Settings.deployOpenAI) {
        foreach ($key in @('openAIModelName', 'openAIModelVersion', 'openAIDeploymentName', 'openAIDeploymentSku')) {
            if ([string]::IsNullOrWhiteSpace($Settings[$key])) {
                throw "DEPLOY_OPENAI=true requires explicit $key. No model/version/deployment SKU is selected automatically."
            }
        }
    }
}

function Invoke-AzJson {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $result = & az @Arguments --only-show-errors --output json
    if ($LASTEXITCODE -ne 0) { throw "Azure CLI failed: $($Arguments[0..([Math]::Min(2, $Arguments.Count - 1))] -join ' ')" }
    if ($result) { return ($result -join "`n" | ConvertFrom-Json -AsHashtable) }
}

function Assert-AzureContext {
    param([string]$TenantId, [string]$SubscriptionId)
    Assert-TargetIds $TenantId $SubscriptionId
    $account = Invoke-AzJson -Arguments @('account', 'show')
    if ($account.tenantId -ne $TenantId -or $account.id -ne $SubscriptionId) {
        throw 'Active Azure CLI tenant/subscription does not match the explicit target. Authenticate and select the intended target manually, then retry. No resources were changed.'
    }
    return $account
}

function Assert-NoSoftDeletedResources {
    param([System.Collections.IDictionary]$Settings, [string]$SubscriptionId)
    if (-not $Settings.deployContentUnderstanding -and -not $Settings.deployOpenAI) { return }
    $deleted = Invoke-AzJson -Arguments @('cognitiveservices', 'account', 'list-deleted', '--subscription', $SubscriptionId)
    $prefixes = @()
    if ($Settings.deployContentUnderstanding) { $prefixes += "cu-$($Settings.environmentName)-" }
    if ($Settings.deployOpenAI) { $prefixes += "oai-$($Settings.environmentName)-" }
    foreach ($account in $deleted) {
        foreach ($prefix in $prefixes) {
            if ($account.name.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
                throw "A soft-deleted service uses this environment prefix: $($account.name). Recover it deliberately or choose a new environment name. Nothing was purged."
            }
        }
    }
}

function Write-DemoIds {
    param([string]$Root, [System.Collections.IDictionary]$Outputs)
    $localPath = Join-Path $Root 'demo-ids.local.json'
    $source = if (Test-Path $localPath) { $localPath } else { Join-Path $Root 'demo-ids.template.json' }
    $ids = Get-Content -LiteralPath $source -Raw | ConvertFrom-Json -AsHashtable
    if (-not $ids.ContainsKey('domain') -or -not $ids.domain) { throw 'Configuration has no domain block; refusing to overwrite it.' }
    foreach ($required in @('AZURE_RESOURCE_GROUP', 'SERVICE_APP_ENDPOINT_URL', 'COSMOS_ENDPOINT', 'COSMOS_DATABASE', 'COSMOS_CONTAINER', 'AZURE_CLIENT_ID')) {
        if (-not $Outputs.Contains($required) -or [string]::IsNullOrWhiteSpace([string]$Outputs[$required])) { throw "Missing deployment output $required." }
    }
    $ids['_template'] = $false
    $ids['tenantId'] = Get-Setting 'AZURE_TENANT_ID'
    $ids['subscriptionId'] = Get-Setting 'AZURE_SUBSCRIPTION_ID'
    $ids['resourceGroup'] = $Outputs.AZURE_RESOURCE_GROUP
    $ids['appUrl'] = $Outputs.SERVICE_APP_ENDPOINT_URL
    $ids['cosmosEndpoint'] = $Outputs.COSMOS_ENDPOINT
    $ids['cosmosDatabase'] = $Outputs.COSMOS_DATABASE
    $ids['cosmosContainer'] = $Outputs.COSMOS_CONTAINER
    foreach ($entry in @{
        contentUnderstandingEndpoint = 'CONTENT_UNDERSTANDING_ENDPOINT'
        contentUnderstandingAnalyzerId = 'CONTENT_UNDERSTANDING_ANALYZER_ID'
        contentUnderstandingCompletionModel = 'CONTENT_UNDERSTANDING_COMPLETION_MODEL'
        contentUnderstandingCompletionDeployment = 'CONTENT_UNDERSTANDING_COMPLETION_DEPLOYMENT'
        contentUnderstandingEmbeddingModel = 'CONTENT_UNDERSTANDING_EMBEDDING_MODEL'
        contentUnderstandingEmbeddingDeployment = 'CONTENT_UNDERSTANDING_EMBEDDING_DEPLOYMENT'
    }.GetEnumerator()) {
        $ids[$entry.Key] = $Outputs[$entry.Value]
    }
    $ids.Remove('documentIntelligenceEndpoint')
    $ids['modelEndpoint'] = $Outputs.AZURE_OPENAI_ENDPOINT
    $ids['modelDeployment'] = $Outputs.AZURE_OPENAI_DEPLOYMENT
    $ids['managedIdentityClientId'] = $Outputs.AZURE_CLIENT_ID
    $ids['entraAudience'] = Get-Setting 'ENTRA_AUDIENCE'
    $ids['entraClientId'] = Get-Setting 'ENTRA_CLIENT_ID'
    $ids['entraApiScope'] = Get-Setting 'ENTRA_API_SCOPE'
    $ids['azureOutputs'] = $Outputs
    $staging = "$localPath.new"
    try {
        $ids | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $staging -Encoding utf8NoBOM
        Move-Item -LiteralPath $staging -Destination $localPath -Force
    } finally {
        if (Test-Path $staging) { Remove-Item -LiteralPath $staging -Force }
    }
    $verified = Get-Content -LiteralPath $localPath -Raw | ConvertFrom-Json -AsHashtable
    if (($verified.domain | ConvertTo-Json -Depth 100 -Compress) -cne ($ids.domain | ConvertTo-Json -Depth 100 -Compress)) {
        throw 'Domain verification failed after writing local IDs.'
    }
}

function Initialize-ContentUnderstanding {
    param([string]$Root, [System.Collections.IDictionary]$Settings, [System.Collections.IDictionary]$Outputs)
    if (-not $Settings.deployContentUnderstanding) { return }
    $saved = @{}
    try {
        foreach ($name in @('CONTENT_UNDERSTANDING_ENDPOINT', 'CONTENT_UNDERSTANDING_ANALYZER_ID',
            'CONTENT_UNDERSTANDING_COMPLETION_MODEL', 'CONTENT_UNDERSTANDING_COMPLETION_DEPLOYMENT',
            'CONTENT_UNDERSTANDING_EMBEDDING_MODEL', 'CONTENT_UNDERSTANDING_EMBEDDING_DEPLOYMENT')) {
            if (-not $Outputs.Contains($name) -or [string]::IsNullOrWhiteSpace([string]$Outputs[$name])) {
                throw "Missing Content Understanding deployment output $name."
            }
            $saved[$name] = [Environment]::GetEnvironmentVariable($name)
            [Environment]::SetEnvironmentVariable($name, [string]$Outputs[$name])
        }
        # Local setup uses the operator credential, not the app's managed identity.
        $saved['AZURE_CLIENT_ID'] = [Environment]::GetEnvironmentVariable('AZURE_CLIENT_ID')
        [Environment]::SetEnvironmentVariable('AZURE_CLIENT_ID', $null)
        Push-Location $Root
        try {
            & node (Join-Path $Root 'scripts\configure-content-understanding.mjs')
            if ($LASTEXITCODE -ne 0) { throw "Content Understanding setup failed with code $LASTEXITCODE. Verify setup principal access and RBAC propagation, then retry." }
        } finally { Pop-Location }
    } finally {
        foreach ($entry in $saved.GetEnumerator()) { [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value) }
    }
}

function Get-OutputEnvironment {
    $result = [ordered]@{}
    $wrapper = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\azd.bicep') -Raw
    foreach ($match in [regex]::Matches($wrapper, '(?m)^output ([A-Z][A-Z0-9_]+) ')) {
        $result[$match.Groups[1].Value] = Get-Setting $match.Groups[1].Value
    }
    return $result
}
