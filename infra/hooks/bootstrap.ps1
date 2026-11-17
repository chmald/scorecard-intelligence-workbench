. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'identity.ps1')

function Test-DeploymentInteraction {
    return (Get-Setting 'AZD_NON_INTERACTIVE').ToLowerInvariant() -ne 'true' -and
        (Get-Setting 'CI').ToLowerInvariant() -ne 'true'
}

function Read-DeploymentSetting {
    param([string]$Name, [string]$Prompt, [string]$Default = '')
    $value = Get-Setting $Name
    if (-not $value) {
        if (-not (Test-DeploymentInteraction)) {
            if (-not $Default) { throw "$Name is required for non-interactive deployment." }
            $value = $Default
        } else {
            $answer = Read-Host $Prompt
            $value = if ([string]::IsNullOrWhiteSpace($answer)) { $Default } else { $answer.Trim() }
        }
    }
    [Environment]::SetEnvironmentVariable($Name, $value)
    return $value
}

function Set-WorkbenchAzdValues {
    param([System.Collections.IDictionary]$Values)
    foreach ($entry in $Values.GetEnumerator()) {
        & azd env set $entry.Key ([string]$entry.Value) | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "Unable to persist azd setting $($entry.Key)." }
    }
}

function Initialize-WorkbenchDeployment {
    param([switch]$PersistAzd)
    $tenant = Read-DeploymentSetting 'AZURE_TENANT_ID' 'Approved demo tenant ID'
    $subscription = Read-DeploymentSetting 'AZURE_SUBSCRIPTION_ID' 'Approved subscription ID'
    Assert-TargetIds $tenant $subscription
    $name = Read-DeploymentSetting 'AZURE_ENV_NAME' 'Environment name [workbench01]' 'workbench01'
    if ($name -cnotmatch '^[a-z][a-z0-9]{2,15}$') { throw 'Environment name must be 3-16 lowercase letters/digits, starting with a letter.' }
    $location = Read-DeploymentSetting 'AZURE_LOCATION' 'Azure region [swedencentral]' 'swedencentral'
    $account = $null
    try { $account = Assert-AzureContext $tenant $subscription } catch {
        if (-not (Test-DeploymentInteraction)) { throw }
        Write-Host "Sign in to the explicitly selected tenant $tenant."
        $null = Invoke-AzJson -Arguments @('login', '--tenant', $tenant)
        $null = Invoke-AzJson -Arguments @('account', 'set', '--subscription', $subscription)
        $account = Assert-AzureContext $tenant $subscription
    }
    if ($PersistAzd) {
        & azd auth login --check-status --tenant-id $tenant | Out-Host
        if ($LASTEXITCODE -ne 0) {
            if (-not (Test-DeploymentInteraction)) { throw 'Authenticate azd to AZURE_TENANT_ID before non-interactive deployment.' }
            & azd auth login --tenant-id $tenant | Out-Host
            if ($LASTEXITCODE -ne 0) { throw 'Azure Developer CLI authentication failed.' }
        }
        Set-WorkbenchAzdValues ([ordered]@{
            AZURE_TENANT_ID = $tenant; AZURE_SUBSCRIPTION_ID = $subscription
            AZURE_ENV_NAME = $name; AZURE_LOCATION = $location
        })
    }
    $identityValues = Initialize-WorkbenchIdentity -Settings (Get-DeploymentSettings) -SubscriptionId $subscription
    if ($identityValues) {
        foreach ($entry in $identityValues.GetEnumerator()) {
            [Environment]::SetEnvironmentVariable($entry.Key, [string]$entry.Value)
        }
    }
    $settings = Get-DeploymentSettings
    if ($settings.deployContentUnderstanding -and (-not $settings.contentUnderstandingSetupPrincipalId -or
        ($PersistAzd -and -not (Get-Setting 'CONTENT_UNDERSTANDING_SETUP_PRINCIPAL_ID')))) {
        if ($account.user.type -ne 'user') { throw 'Set CONTENT_UNDERSTANDING_SETUP_PRINCIPAL_ID to the Azure CLI caller object ID for non-user authentication.' }
        $operator = Invoke-AzJson -Arguments @('ad', 'signed-in-user', 'show')
        [Environment]::SetEnvironmentVariable('CONTENT_UNDERSTANDING_SETUP_PRINCIPAL_ID', [string]$operator.id)
        [Environment]::SetEnvironmentVariable('CONTENT_UNDERSTANDING_SETUP_PRINCIPAL_TYPE', 'User')
        $settings = Get-DeploymentSettings
    }
    Assert-DeploymentConfiguration $settings
    if ($PersistAzd) {
        $values = [ordered]@{
            ENTRA_AUDIENCE = $settings.entraAudience
            ENTRA_CLIENT_ID = $settings.entraClientId
            ENTRA_API_SCOPE = $settings.entraApiScope
        }
        if ($settings.contentUnderstandingSetupPrincipalId) {
            $values['AZURE_PRINCIPAL_ID'] = $settings.contentUnderstandingSetupPrincipalId
            $values['AZURE_PRINCIPAL_TYPE'] = $settings.contentUnderstandingSetupPrincipalType
            $values['CONTENT_UNDERSTANDING_SETUP_PRINCIPAL_ID'] = $settings.contentUnderstandingSetupPrincipalId
            $values['CONTENT_UNDERSTANDING_SETUP_PRINCIPAL_TYPE'] = $settings.contentUnderstandingSetupPrincipalType
        }
        Set-WorkbenchAzdValues $values
    }
    return $settings
}
