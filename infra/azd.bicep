targetScope = 'subscription'

@minLength(3)
@maxLength(16)
param environmentName string
param location string
param tenantId string
param entraAudience string
param entraClientId string
param entraApiScope string
param containerImage string = 'mcr.microsoft.com/dotnet/samples:aspnetapp'
param cosmosDatabaseName string = 'workbench'
param cosmosContainerName string = 'state'
param cosmosThroughput int = 400
param logRetentionDays int = 30
param deployContentUnderstanding bool = true
param contentUnderstandingLocation string = ''
param contentUnderstandingAnalyzerId string = 'document_metrics'
param contentUnderstandingCompletionModelName string = 'gpt-5.2'
param contentUnderstandingCompletionModelVersion string = '2025-12-11'
param contentUnderstandingCompletionDeploymentName string = 'document-completion'
param contentUnderstandingCompletionDeploymentSku string = 'GlobalStandard'
param contentUnderstandingCompletionCapacity int = 1
param contentUnderstandingEmbeddingModelName string = 'text-embedding-3-large'
param contentUnderstandingEmbeddingModelVersion string = '1'
param contentUnderstandingEmbeddingDeploymentName string = 'document-embedding'
param contentUnderstandingEmbeddingDeploymentSku string = 'GlobalStandard'
param contentUnderstandingEmbeddingCapacity int = 1
param contentUnderstandingSetupPrincipalId string = ''
param contentUnderstandingSetupPrincipalType string = 'User'
param deployOpenAI bool = true
param openAILocation string = ''
param openAIModelName string = 'gpt-5.2'
param openAIModelVersion string = '2025-12-11'
param openAIDeploymentName string = 'answers'
param openAIDeploymentSku string = 'GlobalStandard'
param openAICapacity int = 1
param resourceGroupName string = ''

resource group 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: empty(resourceGroupName) ? 'rg-${environmentName}' : resourceGroupName
  location: location
  tags: {
    'azd-env-name': environmentName
    'azd-service-name': 'app'
  }
}

module resources 'main.bicep' = {
  name: 'workbench-${environmentName}'
  scope: group
  params: {
    environmentName: environmentName
    location: location
    tenantId: tenantId
    entraAudience: entraAudience
    entraClientId: entraClientId
    entraApiScope: entraApiScope
    containerImage: containerImage
    cosmosDatabaseName: cosmosDatabaseName
    cosmosContainerName: cosmosContainerName
    cosmosThroughput: cosmosThroughput
    logRetentionDays: logRetentionDays
    deployContentUnderstanding: deployContentUnderstanding
    contentUnderstandingLocation: contentUnderstandingLocation
    contentUnderstandingAnalyzerId: contentUnderstandingAnalyzerId
    contentUnderstandingCompletionModelName: contentUnderstandingCompletionModelName
    contentUnderstandingCompletionModelVersion: contentUnderstandingCompletionModelVersion
    contentUnderstandingCompletionDeploymentName: contentUnderstandingCompletionDeploymentName
    contentUnderstandingCompletionDeploymentSku: contentUnderstandingCompletionDeploymentSku
    contentUnderstandingCompletionCapacity: contentUnderstandingCompletionCapacity
    contentUnderstandingEmbeddingModelName: contentUnderstandingEmbeddingModelName
    contentUnderstandingEmbeddingModelVersion: contentUnderstandingEmbeddingModelVersion
    contentUnderstandingEmbeddingDeploymentName: contentUnderstandingEmbeddingDeploymentName
    contentUnderstandingEmbeddingDeploymentSku: contentUnderstandingEmbeddingDeploymentSku
    contentUnderstandingEmbeddingCapacity: contentUnderstandingEmbeddingCapacity
    contentUnderstandingSetupPrincipalId: contentUnderstandingSetupPrincipalId
    contentUnderstandingSetupPrincipalType: contentUnderstandingSetupPrincipalType
    deployOpenAI: deployOpenAI
    openAILocation: openAILocation
    openAIModelName: openAIModelName
    openAIModelVersion: openAIModelVersion
    openAIDeploymentName: openAIDeploymentName
    openAIDeploymentSku: openAIDeploymentSku
    openAICapacity: openAICapacity
  }
}

output AZURE_LOCATION string = resources.outputs.AZURE_LOCATION
output AZURE_TENANT_ID string = resources.outputs.AZURE_TENANT_ID
output ENTRA_CLIENT_ID string = resources.outputs.ENTRA_CLIENT_ID
output ENTRA_API_SCOPE string = resources.outputs.ENTRA_API_SCOPE
output AZURE_RESOURCE_GROUP string = resources.outputs.AZURE_RESOURCE_GROUP
output AZURE_CONTAINER_REGISTRY_NAME string = resources.outputs.AZURE_CONTAINER_REGISTRY_NAME
output AZURE_CONTAINER_REGISTRY_ENDPOINT string = resources.outputs.AZURE_CONTAINER_REGISTRY_ENDPOINT
output AZURE_CONTAINER_APPS_ENVIRONMENT_ID string = resources.outputs.AZURE_CONTAINER_APPS_ENVIRONMENT_ID
output AZURE_CONTAINER_APP_NAME string = resources.outputs.AZURE_CONTAINER_APP_NAME
output SERVICE_APP_RESOURCE_NAME string = resources.outputs.SERVICE_APP_RESOURCE_NAME
output SERVICE_APP_ENDPOINT_URL string = resources.outputs.SERVICE_APP_ENDPOINT_URL
output AZURE_CLIENT_ID string = resources.outputs.AZURE_CLIENT_ID
output AZURE_MANAGED_IDENTITY_ID string = resources.outputs.AZURE_MANAGED_IDENTITY_ID
output AZURE_MANAGED_IDENTITY_PRINCIPAL_ID string = resources.outputs.AZURE_MANAGED_IDENTITY_PRINCIPAL_ID
output COSMOS_ACCOUNT_NAME string = resources.outputs.COSMOS_ACCOUNT_NAME
output COSMOS_ENDPOINT string = resources.outputs.COSMOS_ENDPOINT
output COSMOS_DATABASE string = resources.outputs.COSMOS_DATABASE
output COSMOS_CONTAINER string = resources.outputs.COSMOS_CONTAINER
output CONTENT_UNDERSTANDING_ACCOUNT_NAME string = resources.outputs.CONTENT_UNDERSTANDING_ACCOUNT_NAME
output CONTENT_UNDERSTANDING_ACCOUNT_ID string = resources.outputs.CONTENT_UNDERSTANDING_ACCOUNT_ID
output CONTENT_UNDERSTANDING_ENDPOINT string = resources.outputs.CONTENT_UNDERSTANDING_ENDPOINT
output CONTENT_UNDERSTANDING_ANALYZER_ID string = resources.outputs.CONTENT_UNDERSTANDING_ANALYZER_ID
output CONTENT_UNDERSTANDING_COMPLETION_MODEL string = resources.outputs.CONTENT_UNDERSTANDING_COMPLETION_MODEL
output CONTENT_UNDERSTANDING_COMPLETION_DEPLOYMENT string = resources.outputs.CONTENT_UNDERSTANDING_COMPLETION_DEPLOYMENT
output CONTENT_UNDERSTANDING_EMBEDDING_MODEL string = resources.outputs.CONTENT_UNDERSTANDING_EMBEDDING_MODEL
output CONTENT_UNDERSTANDING_EMBEDDING_DEPLOYMENT string = resources.outputs.CONTENT_UNDERSTANDING_EMBEDDING_DEPLOYMENT
output AZURE_OPENAI_ENDPOINT string = resources.outputs.AZURE_OPENAI_ENDPOINT
output AZURE_OPENAI_DEPLOYMENT string = resources.outputs.AZURE_OPENAI_DEPLOYMENT
output APPLICATIONINSIGHTS_CONNECTION_STRING string = resources.outputs.APPLICATIONINSIGHTS_CONNECTION_STRING
output LOG_ANALYTICS_WORKSPACE_ID string = resources.outputs.LOG_ANALYTICS_WORKSPACE_ID
