[CmdletBinding()]
param(
    [ValidateRange(1, 65535)][int]$Port = 8080,
    [ValidateSet('local', 'azure')][string]$ExtractionProvider = 'local',
    [ValidateSet('local', 'azure')][string]$AnswerProvider = 'local',
    [string]$TenantId = $env:AZURE_TENANT_ID,
    [string]$SubscriptionId = $env:AZURE_SUBSCRIPTION_ID
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\infra\hooks\common.ps1')
if ($ExtractionProvider -eq 'azure') {
    foreach ($name in @('CONTENT_UNDERSTANDING_ENDPOINT', 'CONTENT_UNDERSTANDING_ANALYZER_ID',
        'CONTENT_UNDERSTANDING_COMPLETION_MODEL', 'CONTENT_UNDERSTANDING_COMPLETION_DEPLOYMENT',
        'CONTENT_UNDERSTANDING_EMBEDDING_MODEL', 'CONTENT_UNDERSTANDING_EMBEDDING_DEPLOYMENT')) {
        if ([string]::IsNullOrWhiteSpace((Get-Setting $name))) { throw "$name is required for Azure Content Understanding extraction." }
    }
}
if ($ExtractionProvider -eq 'azure' -or $AnswerProvider -eq 'azure') {
    $null = Assert-AzureContext $TenantId $SubscriptionId
    $env:AZURE_TENANT_ID = $TenantId
    $env:AZURE_SUBSCRIPTION_ID = $SubscriptionId
}
$env:AUTH_MODE = 'local'
$env:STATE_PROVIDER = 'local'
$env:COSMOS_ENDPOINT = ''
$env:HOST = '127.0.0.1'
$env:PORT = [string]$Port
$env:EXTRACTION_PROVIDER = $ExtractionProvider
$env:ANSWER_PROVIDER = $AnswerProvider
$env:NODE_ENV = 'development'
Push-Location (Join-Path $PSScriptRoot '..')
try {
    & node 'app\server.mjs'
    if ($LASTEXITCODE -ne 0) { throw "Application exited with code $LASTEXITCODE." }
} finally { Pop-Location }
