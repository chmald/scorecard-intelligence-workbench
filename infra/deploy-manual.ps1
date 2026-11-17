function Invoke-ArmRequest {
    param([string]$Method, [string]$ResourceId, [string]$ApiVersion, [hashtable]$Body, [string]$Root)
    $arguments = @('rest', '--method', $Method, '--url', "https://management.azure.com${ResourceId}?api-version=$ApiVersion")
    $requestFile = Join-Path $Root "infra\request.$([guid]::NewGuid().ToString('N')).local.json"
    try {
        if ($Body) {
            $Body | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $requestFile -Encoding utf8NoBOM
            $arguments += @('--body', "@$requestFile")
        }
        return Invoke-AzJson -Arguments $arguments
    } finally {
        if (Test-Path $requestFile) { Remove-Item -LiteralPath $requestFile -Force }
    }
}

function Set-ArmResource {
    param([string]$Id, [string]$Version, [hashtable]$Body, [string]$Root)
    $result = Invoke-ArmRequest -Method put -ResourceId $Id -ApiVersion $Version -Body $Body -Root $Root
    $deadline = [DateTime]::UtcNow.AddMinutes(30)
    while ($result.ContainsKey('properties') -and $result.properties.ContainsKey('provisioningState') -and
        $result.properties.provisioningState -notin @('Succeeded', 'succeeded')) {
        if ($result.properties.provisioningState -in @('Failed', 'Canceled', 'Cancelled') -or [DateTime]::UtcNow -gt $deadline) {
            throw "Resource did not provision successfully: $Id. Inspect Azure Activity Log."
        }
        Start-Sleep -Seconds 10
        $result = Invoke-ArmRequest -Method get -ResourceId $Id -ApiVersion $Version -Root $Root
    }
    return $result
}

function Invoke-ManualDeployment {
    param([System.Collections.IDictionary]$Settings, [string]$SubscriptionId, [string]$Root)
    $s = $Settings
    $groupId = "/subscriptions/$SubscriptionId/resourceGroups/$($s.resourceGroupName)"
    $digest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($groupId.ToLowerInvariant()))).ToLowerInvariant().Substring(0, 13)
    $suffix = "$($s.environmentName)-$($digest.Substring(0, 10))"
    $tags = @{ 'azd-env-name' = $s.environmentName; 'azd-service-name' = 'app' }
    $location = $s.location
    $null = Set-ArmResource $groupId '2024-03-01' @{ location = $location; tags = $tags } $Root
    $identityId = "$groupId/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-$suffix"
    $identity = Set-ArmResource $identityId '2023-01-31' @{ location = $location; tags = $tags } $Root
    $registryName = "acr$($s.environmentName)$digest"
    $registryId = "$groupId/providers/Microsoft.ContainerRegistry/registries/$registryName"
    $registry = Set-ArmResource $registryId '2025-11-01' @{
        location = $location; tags = $tags; sku = @{ name = 'Basic' }
        properties = @{ adminUserEnabled = $false; roleAssignmentMode = 'LegacyRegistryPermissions'
            policies = @{ azureADAuthenticationAsArmPolicy = @{ status = 'enabled' } } }
    } $Root
    $logsId = "$groupId/providers/Microsoft.OperationalInsights/workspaces/log-$suffix"
    $logs = Set-ArmResource $logsId '2023-09-01' @{
        location = $location; tags = $tags
        properties = @{ sku = @{ name = 'PerGB2018' }; retentionInDays = $s.logRetentionDays }
    } $Root
    $logKeys = Invoke-ArmRequest -Method post -ResourceId "$logsId/sharedKeys" -ApiVersion '2023-09-01' -Root $Root
    $insightsId = "$groupId/providers/Microsoft.Insights/components/appi-$suffix"
    $insights = Set-ArmResource $insightsId '2020-02-02' @{
        location = $location; tags = $tags; kind = 'web'
        properties = @{ Application_Type = 'web'; WorkspaceResourceId = $logsId }
    } $Root
    $environmentId = "$groupId/providers/Microsoft.App/managedEnvironments/cae-$suffix"
    $null = Set-ArmResource $environmentId '2026-07-01' @{
        location = $location; tags = $tags
        properties = @{
            environmentMode = 'WorkloadProfiles'
            appLogsConfiguration = @{ destination = 'log-analytics'
                logAnalyticsConfiguration = @{ customerId = $logs.properties.customerId; sharedKey = $logKeys.primarySharedKey } }
            workloadProfiles = @(@{ name = 'Consumption'; workloadProfileType = 'Consumption' })
        }
    } $Root
    $cosmosName = "cos-$suffix"
    $cosmosId = "$groupId/providers/Microsoft.DocumentDB/databaseAccounts/$cosmosName"
    $cosmos = Set-ArmResource $cosmosId '2024-05-15' @{
        location = $location; tags = $tags; kind = 'GlobalDocumentDB'
        properties = @{ databaseAccountOfferType = 'Standard'; disableLocalAuth = $true; minimalTlsVersion = 'Tls12'
            consistencyPolicy = @{ defaultConsistencyLevel = 'Session' }
            locations = @(@{ locationName = $location; failoverPriority = 0; isZoneRedundant = $false }) }
    } $Root
    $databaseId = "$cosmosId/sqlDatabases/$($s.cosmosDatabaseName)"
    $null = Set-ArmResource $databaseId '2024-05-15' @{ properties = @{ resource = @{ id = $s.cosmosDatabaseName } } } $Root
    $containerId = "$databaseId/containers/$($s.cosmosContainerName)"
    $null = Set-ArmResource $containerId '2024-05-15' @{
        properties = @{ resource = @{ id = $s.cosmosContainerName; partitionKey = @{ paths = @('/id'); kind = 'Hash'; version = 2 } }
            options = @{ throughput = $s.cosmosThroughput } }
    } $Root
    $principalId = $identity.properties.principalId
    $clientId = $identity.properties.clientId
    $null = Invoke-AzJson -Arguments @('role', 'assignment', 'create', '--subscription', $SubscriptionId, '--assignee-object-id', $principalId,
        '--assignee-principal-type', 'ServicePrincipal', '--role', '7f951dda-4ed3-4680-a7ca-43fe172d538d', '--scope', $registryId)
    $null = Invoke-AzJson -Arguments @('cosmosdb', 'sql', 'role', 'assignment', 'create', '--subscription', $SubscriptionId,
        '--resource-group', $s.resourceGroupName, '--account-name', $cosmosName, '--principal-id', $principalId,
        '--role-definition-id', '00000000-0000-0000-0000-000000000002', '--scope', "/dbs/$($s.cosmosDatabaseName)/colls/$($s.cosmosContainerName)")
    $contentEndpoint = ''
    $contentAccountName = ''
    $contentAccountId = ''
    $openAIEndpoint = ''
    foreach ($service in @(
        @{ enabled = $s.deployContentUnderstanding; prefix = 'cu'; kind = 'AIServices'; location = $s.contentUnderstandingLocation; role = 'a97b65f3-24c7-4388-baec-2e87135dc908' },
        @{ enabled = $s.deployOpenAI; prefix = 'oai'; kind = 'OpenAI'; location = $s.openAILocation; role = '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd' }
    )) {
        if (-not $service.enabled) { continue }
        $serviceName = "$($service.prefix)-$suffix"
        $serviceId = "$groupId/providers/Microsoft.CognitiveServices/accounts/$serviceName"
        $serviceLocation = if ($service.location) { $service.location } else { $location }
        $account = Set-ArmResource $serviceId '2026-09-01' @{
            location = $serviceLocation; tags = $tags; kind = $service.kind; sku = @{ name = 'S0' }
            properties = @{ customSubDomainName = $serviceName; disableLocalAuth = $true; publicNetworkAccess = 'Enabled' }
        } $Root
        $null = Invoke-AzJson -Arguments @('role', 'assignment', 'create', '--subscription', $SubscriptionId, '--assignee-object-id', $principalId,
            '--assignee-principal-type', 'ServicePrincipal', '--role', $service.role, '--scope', $serviceId)
        if ($service.kind -eq 'AIServices') {
            $contentEndpoint = $account.properties.endpoint
            $contentAccountName = $serviceName
            $contentAccountId = $serviceId
            $null = Invoke-AzJson -Arguments @('role', 'assignment', 'create', '--subscription', $SubscriptionId,
                '--assignee-object-id', $s.contentUnderstandingSetupPrincipalId,
                '--assignee-principal-type', $s.contentUnderstandingSetupPrincipalType,
                '--role', $service.role, '--scope', $serviceId)
            foreach ($kind in @('Completion', 'Embedding')) {
                $null = Set-ArmResource "$serviceId/deployments/$($s["contentUnderstanding${kind}DeploymentName"])" '2026-09-01' @{
                    sku = @{ name = $s["contentUnderstanding${kind}DeploymentSku"]; capacity = $s["contentUnderstanding${kind}Capacity"] }
                    properties = @{
                        model = @{ format = 'OpenAI'; name = $s["contentUnderstanding${kind}ModelName"]; version = $s["contentUnderstanding${kind}ModelVersion"] }
                        versionUpgradeOption = 'NoAutoUpgrade'
                    }
                } $Root
            }
        }
        else {
            $openAIEndpoint = $account.properties.endpoint
            $null = Set-ArmResource "$serviceId/deployments/$($s.openAIDeploymentName)" '2026-09-01' @{
                sku = @{ name = $s.openAIDeploymentSku; capacity = $s.openAICapacity }
                properties = @{ model = @{ format = 'OpenAI'; name = $s.openAIModelName; version = $s.openAIModelVersion }
                    versionUpgradeOption = 'NoAutoUpgrade' }
            } $Root
        }
    }
    $tag = "app:$([DateTime]::UtcNow.ToString('yyyyMMddHHmmss'))"
    $null = Invoke-AzJson -Arguments @('acr', 'build', '--subscription', $SubscriptionId, '--registry', $registryName, '--image', $tag, '--file', 'Dockerfile', '--no-logs', '.')
    $image = "$($registry.properties.loginServer)/$tag"
    $appName = "app-$suffix"
    $appId = "$groupId/providers/Microsoft.App/containerApps/$appName"
    $runtime = [ordered]@{
        NODE_ENV = 'production'; HOST = '0.0.0.0'; PORT = '8080'; AUTH_MODE = 'entra'
        AZURE_TENANT_ID = $s.tenantId; AZURE_SUBSCRIPTION_ID = $SubscriptionId; ENTRA_AUDIENCE = $s.entraAudience; AZURE_CLIENT_ID = $clientId
        ENTRA_CLIENT_ID = $s.entraClientId; ENTRA_API_SCOPE = $s.entraApiScope
        COSMOS_ENDPOINT = $cosmos.properties.documentEndpoint; COSMOS_DATABASE = $s.cosmosDatabaseName; COSMOS_CONTAINER = $s.cosmosContainerName
        EXTRACTION_PROVIDER = $(if ($s.deployContentUnderstanding) { 'azure' } else { 'local' })
        ANSWER_PROVIDER = $(if ($s.deployOpenAI) { 'azure' } else { 'local' })
        CONTENT_UNDERSTANDING_ENDPOINT = $contentEndpoint
        CONTENT_UNDERSTANDING_ANALYZER_ID = $(if ($s.deployContentUnderstanding) { $s.contentUnderstandingAnalyzerId } else { '' })
        CONTENT_UNDERSTANDING_COMPLETION_MODEL = $(if ($s.deployContentUnderstanding) { $s.contentUnderstandingCompletionModelName } else { '' })
        CONTENT_UNDERSTANDING_COMPLETION_DEPLOYMENT = $(if ($s.deployContentUnderstanding) { $s.contentUnderstandingCompletionDeploymentName } else { '' })
        CONTENT_UNDERSTANDING_EMBEDDING_MODEL = $(if ($s.deployContentUnderstanding) { $s.contentUnderstandingEmbeddingModelName } else { '' })
        CONTENT_UNDERSTANDING_EMBEDDING_DEPLOYMENT = $(if ($s.deployContentUnderstanding) { $s.contentUnderstandingEmbeddingDeploymentName } else { '' })
        AZURE_OPENAI_ENDPOINT = $openAIEndpoint
        AZURE_OPENAI_DEPLOYMENT = $(if ($s.deployOpenAI) { $s.openAIDeploymentName } else { '' })
        APPLICATIONINSIGHTS_CONNECTION_STRING = $insights.properties.ConnectionString
    }
    $environmentVariables = @($runtime.GetEnumerator() | ForEach-Object { @{ name = $_.Key; value = [string]$_.Value } })
    $app = Set-ArmResource $appId '2026-07-01' @{
        location = $location; tags = $tags
        identity = @{ type = 'UserAssigned'; userAssignedIdentities = @{ $identityId = @{} } }
        properties = @{
            managedEnvironmentId = $environmentId; workloadProfileName = 'Consumption'
            configuration = @{ activeRevisionsMode = 'Single'
                ingress = @{ external = $true; allowInsecure = $false; targetPort = 8080; transport = 'auto' }
                registries = @(@{ server = $registry.properties.loginServer; identity = $identityId }) }
            template = @{
                containers = @(@{ name = 'app'; image = $image; env = $environmentVariables
                    resources = @{ cpu = 0.5; memory = '1Gi' }
                    probes = @(
                        @{ type = 'Readiness'; httpGet = @{ path = '/health'; port = 8080 }; initialDelaySeconds = 5; periodSeconds = 10; failureThreshold = 6 },
                        @{ type = 'Liveness'; httpGet = @{ path = '/health'; port = 8080 }; initialDelaySeconds = 30; periodSeconds = 30; failureThreshold = 3 }
                    ) })
                scale = @{ minReplicas = 1; maxReplicas = 1 }
            }
        }
    } $Root
    return [ordered]@{
        AZURE_LOCATION = $location; AZURE_TENANT_ID = $s.tenantId; AZURE_RESOURCE_GROUP = $s.resourceGroupName
        ENTRA_CLIENT_ID = $s.entraClientId; ENTRA_API_SCOPE = $s.entraApiScope
        AZURE_CONTAINER_REGISTRY_NAME = $registryName; AZURE_CONTAINER_REGISTRY_ENDPOINT = $registry.properties.loginServer
        AZURE_CONTAINER_APPS_ENVIRONMENT_ID = $environmentId; AZURE_CONTAINER_APP_NAME = $appName; SERVICE_APP_RESOURCE_NAME = $appName
        SERVICE_APP_ENDPOINT_URL = "https://$($app.properties.configuration.ingress.fqdn)"
        AZURE_CLIENT_ID = $clientId; AZURE_MANAGED_IDENTITY_ID = $identityId; AZURE_MANAGED_IDENTITY_PRINCIPAL_ID = $principalId
        COSMOS_ACCOUNT_NAME = $cosmosName; COSMOS_ENDPOINT = $cosmos.properties.documentEndpoint; COSMOS_DATABASE = $s.cosmosDatabaseName; COSMOS_CONTAINER = $s.cosmosContainerName
        CONTENT_UNDERSTANDING_ACCOUNT_NAME = $contentAccountName; CONTENT_UNDERSTANDING_ACCOUNT_ID = $contentAccountId
        CONTENT_UNDERSTANDING_ENDPOINT = $contentEndpoint
        CONTENT_UNDERSTANDING_ANALYZER_ID = $runtime.CONTENT_UNDERSTANDING_ANALYZER_ID
        CONTENT_UNDERSTANDING_COMPLETION_MODEL = $runtime.CONTENT_UNDERSTANDING_COMPLETION_MODEL
        CONTENT_UNDERSTANDING_COMPLETION_DEPLOYMENT = $runtime.CONTENT_UNDERSTANDING_COMPLETION_DEPLOYMENT
        CONTENT_UNDERSTANDING_EMBEDDING_MODEL = $runtime.CONTENT_UNDERSTANDING_EMBEDDING_MODEL
        CONTENT_UNDERSTANDING_EMBEDDING_DEPLOYMENT = $runtime.CONTENT_UNDERSTANDING_EMBEDDING_DEPLOYMENT
        AZURE_OPENAI_ENDPOINT = $openAIEndpoint
        AZURE_OPENAI_DEPLOYMENT = $(if ($s.deployOpenAI) { $s.openAIDeploymentName } else { '' })
        APPLICATIONINSIGHTS_CONNECTION_STRING = $insights.properties.ConnectionString; LOG_ANALYTICS_WORKSPACE_ID = $logsId
    }
}
