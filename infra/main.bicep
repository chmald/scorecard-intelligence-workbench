targetScope = 'resourceGroup'

@minLength(3)
@maxLength(16)
param environmentName string
param location string
@minLength(1)
param tenantId string
@minLength(1)
@description('Existing single-tenant API application client ID (v2 access-token audience); operator configures reviewer, manager and auditor application roles.')
param entraAudience string
@minLength(1)
@description('Existing public SPA application client ID. No client secret is used.')
param entraClientId string
@minLength(1)
@description('Delegated API scope under api://<entraAudience>/; configure consent on the SPA registration.')
param entraApiScope string
@description('Bootstrap image listens on 8080. azd deploy replaces it with the remotely built application image.')
param containerImage string = 'mcr.microsoft.com/dotnet/samples:aspnetapp'
param cosmosDatabaseName string = 'workbench'
param cosmosContainerName string = 'state'
@minValue(400)
param cosmosThroughput int = 400
@minValue(30)
@maxValue(730)
param logRetentionDays int = 30
param deployContentUnderstanding bool = true
param contentUnderstandingLocation string = ''
param contentUnderstandingAnalyzerId string = 'document_metrics'
param contentUnderstandingCompletionModelName string = 'gpt-5.2'
param contentUnderstandingCompletionModelVersion string = '2025-12-11'
param contentUnderstandingCompletionDeploymentName string = 'document-completion'
param contentUnderstandingCompletionDeploymentSku string = 'GlobalStandard'
@minValue(1)
param contentUnderstandingCompletionCapacity int = 1
param contentUnderstandingEmbeddingModelName string = 'text-embedding-3-large'
param contentUnderstandingEmbeddingModelVersion string = '1'
param contentUnderstandingEmbeddingDeploymentName string = 'document-embedding'
param contentUnderstandingEmbeddingDeploymentSku string = 'GlobalStandard'
@minValue(1)
param contentUnderstandingEmbeddingCapacity int = 1
param contentUnderstandingSetupPrincipalId string = ''
@allowed([
  'User'
  'ServicePrincipal'
  'Group'
])
param contentUnderstandingSetupPrincipalType string = 'User'
param deployOpenAI bool = true
param openAILocation string = ''
param openAIModelName string = 'gpt-5.2'
param openAIModelVersion string = '2025-12-11'
param openAIDeploymentName string = 'answers'
param openAIDeploymentSku string = 'GlobalStandard'
@minValue(1)
param openAICapacity int = 1

var suffix = '${environmentName}-${take(uniqueString(resourceGroup().id), 10)}'
var tags = {
  'azd-env-name': environmentName
}
var acrPullRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
var cognitiveUserRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'a97b65f3-24c7-4388-baec-2e87135dc908')
var openAIUserRole = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd')

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${suffix}'
  location: location
  tags: tags
}

resource registry 'Microsoft.ContainerRegistry/registries@2025-11-01' = {
  name: 'acr${environmentName}${uniqueString(resourceGroup().id)}'
  location: location
  tags: tags
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
    roleAssignmentMode: 'LegacyRegistryPermissions'
    policies: {
      azureADAuthenticationAsArmPolicy: {
        status: 'enabled'
      }
    }
  }
}

resource registryPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, identity.id, acrPullRole)
  scope: registry
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: acrPullRole
  }
}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${suffix}'
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: logRetentionDays
  }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-${suffix}'
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logs.id
  }
}

resource managedEnvironment 'Microsoft.App/managedEnvironments@2026-07-01' = {
  name: 'cae-${suffix}'
  location: location
  tags: tags
  properties: {
    environmentMode: 'WorkloadProfiles'
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
  }
}

resource cosmos 'Microsoft.DocumentDB/databaseAccounts@2024-05-15' = {
  name: 'cos-${suffix}'
  location: location
  tags: tags
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    disableLocalAuth: true
    minimalTlsVersion: 'Tls12'
    consistencyPolicy: {
      defaultConsistencyLevel: 'Session'
    }
    locations: [
      {
        locationName: location
        failoverPriority: 0
        isZoneRedundant: false
      }
    ]
  }
}

resource database 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-05-15' = {
  parent: cosmos
  name: cosmosDatabaseName
  properties: {
    resource: {
      id: cosmosDatabaseName
    }
  }
}

resource state 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = {
  parent: database
  name: cosmosContainerName
  properties: {
    resource: {
      id: cosmosContainerName
      partitionKey: {
        paths: [
          '/id'
        ]
        kind: 'Hash'
        version: 2
      }
    }
    options: {
      throughput: cosmosThroughput
    }
  }
}

resource cosmosWriter 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-05-15' = {
  parent: cosmos
  name: guid(cosmos.id, identity.id, 'data-contributor')
  properties: {
    principalId: identity.properties.principalId
    roleDefinitionId: '${cosmos.id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002'
    scope: '${cosmos.id}/dbs/${database.name}/colls/${state.name}'
  }
}

resource contentUnderstanding 'Microsoft.CognitiveServices/accounts@2026-09-01' = if (deployContentUnderstanding) {
  name: 'cu-${suffix}'
  location: empty(contentUnderstandingLocation) ? location : contentUnderstandingLocation
  tags: tags
  kind: 'AIServices'
  sku: {
    name: 'S0'
  }
  properties: {
    customSubDomainName: 'cu-${suffix}'
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}

resource contentReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployContentUnderstanding) {
  scope: contentUnderstanding
  name: guid(contentUnderstanding.id, identity.id, cognitiveUserRole)
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: cognitiveUserRole
  }
}

resource contentSetup 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployContentUnderstanding) {
  scope: contentUnderstanding
  name: guid(contentUnderstanding.id, contentUnderstandingSetupPrincipalId, cognitiveUserRole)
  properties: {
    principalId: contentUnderstandingSetupPrincipalId
    principalType: contentUnderstandingSetupPrincipalType
    roleDefinitionId: cognitiveUserRole
  }
}

resource contentCompletion 'Microsoft.CognitiveServices/accounts/deployments@2026-09-01' = if (deployContentUnderstanding) {
  parent: contentUnderstanding
  name: contentUnderstandingCompletionDeploymentName
  sku: {
    name: contentUnderstandingCompletionDeploymentSku
    capacity: contentUnderstandingCompletionCapacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: contentUnderstandingCompletionModelName
      version: contentUnderstandingCompletionModelVersion
    }
    versionUpgradeOption: 'NoAutoUpgrade'
  }
}

resource contentEmbedding 'Microsoft.CognitiveServices/accounts/deployments@2026-09-01' = if (deployContentUnderstanding) {
  parent: contentUnderstanding
  name: contentUnderstandingEmbeddingDeploymentName
  sku: {
    name: contentUnderstandingEmbeddingDeploymentSku
    capacity: contentUnderstandingEmbeddingCapacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: contentUnderstandingEmbeddingModelName
      version: contentUnderstandingEmbeddingModelVersion
    }
    versionUpgradeOption: 'NoAutoUpgrade'
  }
  dependsOn: [
    contentCompletion
  ]
}

resource openAI 'Microsoft.CognitiveServices/accounts@2026-09-01' = if (deployOpenAI) {
  name: 'oai-${suffix}'
  location: empty(openAILocation) ? location : openAILocation
  tags: tags
  kind: 'OpenAI'
  sku: {
    name: 'S0'
  }
  properties: {
    customSubDomainName: 'oai-${suffix}'
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
  }
}

resource model 'Microsoft.CognitiveServices/accounts/deployments@2026-09-01' = if (deployOpenAI) {
  parent: openAI
  name: openAIDeploymentName
  sku: {
    name: openAIDeploymentSku
    capacity: openAICapacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: openAIModelName
      version: openAIModelVersion
    }
    versionUpgradeOption: 'NoAutoUpgrade'
  }
}

resource modelReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployOpenAI) {
  scope: openAI
  name: guid(openAI.id, identity.id, openAIUserRole)
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: openAIUserRole
  }
}

var appEnvironment = [
  { name: 'NODE_ENV', value: 'production' }
  { name: 'HOST', value: '0.0.0.0' }
  { name: 'PORT', value: '8080' }
  { name: 'AUTH_MODE', value: 'entra' }
  { name: 'AZURE_TENANT_ID', value: tenantId }
  { name: 'AZURE_SUBSCRIPTION_ID', value: subscription().subscriptionId }
  { name: 'ENTRA_AUDIENCE', value: entraAudience }
  { name: 'ENTRA_CLIENT_ID', value: entraClientId }
  { name: 'ENTRA_API_SCOPE', value: entraApiScope }
  { name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }
  { name: 'COSMOS_ENDPOINT', value: cosmos.properties.documentEndpoint }
  { name: 'COSMOS_DATABASE', value: cosmosDatabaseName }
  { name: 'COSMOS_CONTAINER', value: cosmosContainerName }
  { name: 'EXTRACTION_PROVIDER', value: deployContentUnderstanding ? 'azure' : 'local' }
  { name: 'ANSWER_PROVIDER', value: deployOpenAI ? 'azure' : 'local' }
  { name: 'CONTENT_UNDERSTANDING_ENDPOINT', value: deployContentUnderstanding ? contentUnderstanding!.properties.endpoint : '' }
  { name: 'CONTENT_UNDERSTANDING_ANALYZER_ID', value: deployContentUnderstanding ? contentUnderstandingAnalyzerId : '' }
  { name: 'CONTENT_UNDERSTANDING_COMPLETION_MODEL', value: deployContentUnderstanding ? contentUnderstandingCompletionModelName : '' }
  { name: 'CONTENT_UNDERSTANDING_COMPLETION_DEPLOYMENT', value: deployContentUnderstanding ? contentCompletion.name : '' }
  { name: 'CONTENT_UNDERSTANDING_EMBEDDING_MODEL', value: deployContentUnderstanding ? contentUnderstandingEmbeddingModelName : '' }
  { name: 'CONTENT_UNDERSTANDING_EMBEDDING_DEPLOYMENT', value: deployContentUnderstanding ? contentEmbedding.name : '' }
  { name: 'AZURE_OPENAI_ENDPOINT', value: deployOpenAI ? openAI!.properties.endpoint : '' }
  { name: 'AZURE_OPENAI_DEPLOYMENT', value: deployOpenAI ? model.name : '' }
  { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: insights.properties.ConnectionString }
]

resource app 'Microsoft.App/containerApps@2026-07-01' = {
  name: 'app-${suffix}'
  location: location
  tags: union(tags, {
    'azd-service-name': 'app'
  })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: managedEnvironment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        allowInsecure: false
        targetPort: 8080
        transport: 'auto'
      }
      registries: [
        {
          server: registry.properties.loginServer
          identity: identity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'app'
          image: containerImage
          env: appEnvironment
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          // Both the harmless bootstrap and the application serve '/' on port 8080.
          probes: [
            {
              type: 'Readiness'
              httpGet: { path: '/', port: 8080 }
              initialDelaySeconds: 5
              periodSeconds: 10
              failureThreshold: 6
            }
            {
              type: 'Liveness'
              httpGet: { path: '/', port: 8080 }
              initialDelaySeconds: 30
              periodSeconds: 30
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 1
      }
    }
  }
  dependsOn: [
    registryPull
    cosmosWriter
    contentReader
    modelReader
  ]
}

output AZURE_LOCATION string = location
output AZURE_TENANT_ID string = tenantId
output ENTRA_CLIENT_ID string = entraClientId
output ENTRA_API_SCOPE string = entraApiScope
output AZURE_RESOURCE_GROUP string = resourceGroup().name
output AZURE_CONTAINER_REGISTRY_NAME string = registry.name
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = registry.properties.loginServer
output AZURE_CONTAINER_APPS_ENVIRONMENT_ID string = managedEnvironment.id
output AZURE_CONTAINER_APP_NAME string = app.name
output SERVICE_APP_RESOURCE_NAME string = app.name
output SERVICE_APP_ENDPOINT_URL string = 'https://${app.properties.configuration.ingress.fqdn}'
output AZURE_CLIENT_ID string = identity.properties.clientId
output AZURE_MANAGED_IDENTITY_ID string = identity.id
output AZURE_MANAGED_IDENTITY_PRINCIPAL_ID string = identity.properties.principalId
output COSMOS_ACCOUNT_NAME string = cosmos.name
output COSMOS_ENDPOINT string = cosmos.properties.documentEndpoint
output COSMOS_DATABASE string = database.name
output COSMOS_CONTAINER string = state.name
output CONTENT_UNDERSTANDING_ACCOUNT_NAME string = deployContentUnderstanding ? contentUnderstanding!.name : ''
output CONTENT_UNDERSTANDING_ACCOUNT_ID string = deployContentUnderstanding ? contentUnderstanding!.id : ''
output CONTENT_UNDERSTANDING_ENDPOINT string = deployContentUnderstanding ? contentUnderstanding!.properties.endpoint : ''
output CONTENT_UNDERSTANDING_ANALYZER_ID string = deployContentUnderstanding ? contentUnderstandingAnalyzerId : ''
output CONTENT_UNDERSTANDING_COMPLETION_MODEL string = deployContentUnderstanding ? contentUnderstandingCompletionModelName : ''
output CONTENT_UNDERSTANDING_COMPLETION_DEPLOYMENT string = deployContentUnderstanding ? contentCompletion.name : ''
output CONTENT_UNDERSTANDING_EMBEDDING_MODEL string = deployContentUnderstanding ? contentUnderstandingEmbeddingModelName : ''
output CONTENT_UNDERSTANDING_EMBEDDING_DEPLOYMENT string = deployContentUnderstanding ? contentEmbedding.name : ''
output AZURE_OPENAI_ENDPOINT string = deployOpenAI ? openAI!.properties.endpoint : ''
output AZURE_OPENAI_DEPLOYMENT string = deployOpenAI ? model.name : ''
output APPLICATIONINSIGHTS_CONNECTION_STRING string = insights.properties.ConnectionString
output LOG_ANALYTICS_WORKSPACE_ID string = logs.id
