Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-WorkbenchAutomaticIdentity {
    return Get-BooleanSetting 'AUTO_CONFIGURE_ENTRA' 'true'
}

function Get-WorkbenchIdentityValue {
    param([System.Collections.IDictionary]$Dictionary, [string]$Key)
    if ($null -ne $Dictionary -and $Dictionary.Contains($Key)) { return $Dictionary[$Key] }
    return $null
}

function Assert-WorkbenchIdentityGuid {
    param([string]$Value, [string]$Name)
    $parsed = [guid]::Empty
    if (-not [guid]::TryParse($Value, [ref]$parsed) -or $parsed -eq [guid]::Empty) {
        throw "$Name must be a nonzero GUID."
    }
}

function Invoke-WorkbenchGraph {
    param([string]$Method = 'GET', [string]$Path, [System.Collections.IDictionary]$Body)
    $arguments = @('rest', '--method', $Method, '--url', "https://graph.microsoft.com/v1.0/$Path")
    $bodyPath = $null
    try {
        if ($null -ne $Body) {
            # A unique, named file avoids shell JSON quoting and concurrent-hook collisions.
            $bodyPath = Join-Path $PSScriptRoot ".identity-request-$([guid]::NewGuid().ToString('N')).json"
            $Body | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $bodyPath -Encoding utf8NoBOM
            $arguments += @('--headers', 'Content-Type=application/json', '--body', "@$bodyPath")
        }
        return Invoke-AzJson -Arguments $arguments
    } catch {
        throw "Entra identity $Method failed. Verify the signed-in operator has existing directory permission to manage these applications and assign users to application roles (for example Application Administrator or Cloud Application Administrator), then retry azd up. No directory privileges or tenant-wide consent are granted by this hook. For manually managed apps, set AUTO_CONFIGURE_ENTRA=false. Details: $($_.Exception.Message)"
    } finally {
        if ($bodyPath -and (Test-Path -LiteralPath $bodyPath)) { Remove-Item -LiteralPath $bodyPath -Force }
    }
}

function Get-WorkbenchGraphMatches {
    param([string]$Collection, [string]$Filter)
    $path = "${Collection}?`$filter=$([uri]::EscapeDataString($Filter))&`$top=2"
    $response = Invoke-WorkbenchGraph -Path $path
    if ((Get-WorkbenchIdentityValue $response '@odata.nextLink')) {
        throw "Ambiguous $Collection identity lookup; refusing to adopt or modify any matching object."
    }
    return @(Get-WorkbenchIdentityValue $response 'value')
}

function Get-WorkbenchIdentityTarget {
    param([System.Collections.IDictionary]$Settings, [string]$SubscriptionId)
    $tenant = [string](Get-WorkbenchIdentityValue $Settings 'tenantId')
    $null = Assert-AzureContext -TenantId $tenant -SubscriptionId $SubscriptionId
    $environmentName = [string](Get-WorkbenchIdentityValue $Settings 'environmentName')
    if ($environmentName -cnotmatch '^[a-z][a-z0-9]{2,15}$') {
        throw 'Identity setup requires AZURE_ENV_NAME (3-16 lowercase letters/digits, starting with a letter).'
    }
    $identityKey = "$(([guid]$tenant).ToString('D'))/$(([guid]$SubscriptionId).ToString('D'))/$environmentName"
    $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData(
        [Text.Encoding]::UTF8.GetBytes($identityKey))).ToLowerInvariant().Substring(0, 24)
    return @{ name = "scorecard-workbench-$hash"; marker = "scorecard-workbench-managed:$hash" }
}

function Find-WorkbenchApplication {
    param([hashtable]$Target, [string]$Kind, [string]$ClientId)
    $name = "$($Target.name)-$Kind"
    $marker = "$($Target.marker):$Kind"
    $matches = @(Get-WorkbenchGraphMatches 'applications' "displayName eq '$name'")
    if ($matches.Count -gt 1) { throw "Ambiguous application name '$name'; resolve duplicates manually before retrying." }
    $application = if ($matches.Count -eq 1) { $matches[0] } else { $null }
    if ($ClientId) {
        Assert-WorkbenchIdentityGuid $ClientId 'Configured Entra application ID'
        $configured = @(Get-WorkbenchGraphMatches 'applications' "appId eq '$ClientId'")
        if ($configured.Count -ne 1 -or $null -eq $application -or $configured[0].id -ne $application.id) {
            throw 'Configured ENTRA_* application is not the managed application for this target. Set AUTO_CONFIGURE_ENTRA=false to use existing manually managed applications.'
        }
    }
    if ($null -ne $application) {
        if (@(Get-WorkbenchIdentityValue $application 'tags') -cnotcontains $marker -or
            (Get-WorkbenchIdentityValue $application 'signInAudience') -cne 'AzureADMyOrg') {
            throw "Application '$name' is not an owned single-tenant managed application. Refusing to adopt a lookalike. Set AUTO_CONFIGURE_ENTRA=false for manually managed applications."
        }
        Assert-WorkbenchIdentityGuid $application.id 'Application object ID'
        Assert-WorkbenchIdentityGuid $application.appId 'Application client ID'
    }
    return $application
}

function New-WorkbenchApplication {
    param([hashtable]$Target, [string]$Kind)
    $body = @{
        displayName = "$($Target.name)-$Kind"
        tags = @("$($Target.marker):$Kind")
        signInAudience = 'AzureADMyOrg'
        isFallbackPublicClient = $false
        web = @{ implicitGrantSettings = @{ enableAccessTokenIssuance = $false; enableIdTokenIssuance = $false } }
    }
    if ($Kind -eq 'spa') { $body['spa'] = @{ redirectUris = @() } }
    $application = Invoke-WorkbenchGraph -Method POST -Path 'applications' -Body $body
    Assert-WorkbenchIdentityGuid $application.id 'Created application object ID'
    Assert-WorkbenchIdentityGuid $application.appId 'Created application client ID'
    return $application
}

function Test-WorkbenchIdentityShape {
    param($Actual, $Expected)
    if ($null -eq $Expected) { return $null -eq $Actual }
    if ($Expected -is [System.Collections.IDictionary]) {
        if ($Actual -isnot [System.Collections.IDictionary]) { return $false }
        foreach ($key in $Expected.Keys) {
            if (-not $Actual.Contains($key) -or -not (Test-WorkbenchIdentityShape $Actual[$key] $Expected[$key])) { return $false }
        }
        return $true
    }
    if ($Expected -is [array]) {
        $items = @($Actual)
        if ($items.Count -ne $Expected.Count) { return $false }
        foreach ($item in $Expected) {
            if (@($items | Where-Object { Test-WorkbenchIdentityShape $_ $item }).Count -eq 0) { return $false }
        }
        return $true
    }
    return $Actual -ceq $Expected
}

function Confirm-WorkbenchApplication {
    param([string]$ObjectId, [hashtable]$Expected)
    for ($attempt = 0; $attempt -lt 4; $attempt++) {
        $application = Invoke-WorkbenchGraph -Path "applications/$ObjectId"
        if (Test-WorkbenchIdentityShape $application $Expected) { return $application }
        if ($attempt -lt 3) { Start-Sleep -Seconds ($attempt + 1) }
    }
    throw 'Managed application readback mismatch after bounded directory propagation retries. Retry azd up; no successful identity setup is being reported.'
}

function Set-WorkbenchApplication {
    param([System.Collections.IDictionary]$Application, [hashtable]$Desired)
    $patch = @{}
    foreach ($key in $Desired.Keys) {
        if (-not (Test-WorkbenchIdentityShape (Get-WorkbenchIdentityValue $Application $key) $Desired[$key])) {
            $patch[$key] = $Desired[$key]
        }
    }
    if ($patch.Count -gt 0) {
        $null = Invoke-WorkbenchGraph -Method PATCH -Path "applications/$($Application.id)" -Body $patch
    }
    return Confirm-WorkbenchApplication -ObjectId $Application.id -Expected $Desired
}

function Copy-WorkbenchIdentityMap {
    param($Value)
    $copy = @{}
    if ($Value -is [System.Collections.IDictionary]) {
        foreach ($key in $Value.Keys) { $copy[$key] = $Value[$key] }
    }
    return $copy
}

function Get-WorkbenchServicePrincipal {
    param([string]$ClientId)
    $matches = @(Get-WorkbenchGraphMatches 'servicePrincipals' "appId eq '$ClientId'")
    if ($matches.Count -gt 1) { throw 'Ambiguous service principal lookup; refusing to select an identity.' }
    if ($matches.Count -eq 1) { return $matches[0] }
    return Invoke-WorkbenchGraph -Method POST -Path 'servicePrincipals' -Body @{ appId = $ClientId }
}

function Initialize-WorkbenchIdentity {
    param(
        [Parameter(Mandatory)][System.Collections.IDictionary]$Settings,
        [Parameter(Mandatory)][string]$SubscriptionId
    )
    $target = Get-WorkbenchIdentityTarget -Settings $Settings -SubscriptionId $SubscriptionId
    if (-not (Test-WorkbenchAutomaticIdentity)) {
        Write-Host 'Automatic Entra setup disabled. Supply single-tenant API/SPA IDs, delegated scope, consent, app-role assignments and the HTTPS /auth/callback redirect manually.'
        return @{
            ENTRA_AUDIENCE = [string](Get-WorkbenchIdentityValue $Settings 'entraAudience')
            ENTRA_CLIENT_ID = [string](Get-WorkbenchIdentityValue $Settings 'entraClientId')
            ENTRA_API_SCOPE = [string](Get-WorkbenchIdentityValue $Settings 'entraApiScope')
        }
    }
    $apiId = [string](Get-WorkbenchIdentityValue $Settings 'entraAudience')
    $spaId = [string](Get-WorkbenchIdentityValue $Settings 'entraClientId')
    $configuredScope = [string](Get-WorkbenchIdentityValue $Settings 'entraApiScope')
    # Preflight both supplied identities before making any Graph mutation.
    $api = Find-WorkbenchApplication $target 'api' $apiId
    $spa = Find-WorkbenchApplication $target 'spa' $spaId
    if ($configuredScope -and ($null -eq $api -or $configuredScope -cne "api://$($api.appId)/access_as_user")) {
        throw 'ENTRA_API_SCOPE does not match the managed API access_as_user scope. Set AUTO_CONFIGURE_ENTRA=false for manually managed scopes.'
    }
    $operator = Invoke-WorkbenchGraph -Path 'me?$select=id'
    $operatorId = [string](Get-WorkbenchIdentityValue $operator 'id')
    Assert-WorkbenchIdentityGuid $operatorId 'Signed-in operator user ID'
    $values = @{}
    if (-not (Get-Setting 'AZURE_PRINCIPAL_ID')) {
        [Environment]::SetEnvironmentVariable('AZURE_PRINCIPAL_ID', $operatorId)
    }
    $values['AZURE_PRINCIPAL_ID'] = Get-Setting 'AZURE_PRINCIPAL_ID'
    if ($null -eq $api) { $api = New-WorkbenchApplication $target 'api' }
    $values['ENTRA_AUDIENCE'] = [string]$api.appId
    [Environment]::SetEnvironmentVariable('ENTRA_AUDIENCE', $values.ENTRA_AUDIENCE)
    $values['ENTRA_API_SCOPE'] = "api://$($api.appId)/access_as_user"
    [Environment]::SetEnvironmentVariable('ENTRA_API_SCOPE', $values.ENTRA_API_SCOPE)
    if ($null -eq $spa) { $spa = New-WorkbenchApplication $target 'spa' }
    $values['ENTRA_CLIENT_ID'] = [string]$spa.appId
    [Environment]::SetEnvironmentVariable('ENTRA_CLIENT_ID', $values.ENTRA_CLIENT_ID)

    $apiProperties = Copy-WorkbenchIdentityMap (Get-WorkbenchIdentityValue $api 'api')
    $scopes = @((Get-WorkbenchIdentityValue $apiProperties 'oauth2PermissionScopes') | Where-Object { $null -ne $_ })
    $matchingScopes = @($scopes | Where-Object { $_.value -ceq 'access_as_user' })
    if ($matchingScopes.Count -gt 1) { throw 'Managed API has ambiguous access_as_user scopes.' }
    if ($matchingScopes.Count -eq 0) {
        $scope = @{
            id = [guid]::NewGuid().ToString('D'); value = 'access_as_user'; type = 'User'; isEnabled = $true
            adminConsentDisplayName = 'Access the scorecard workbench'
            adminConsentDescription = 'Access the scorecard workbench as the signed-in user.'
            userConsentDisplayName = 'Access the scorecard workbench'
            userConsentDescription = 'Access the scorecard workbench on your behalf.'
        }
        $scopes += $scope
    } else {
        $scope = $matchingScopes[0]
        if (-not $scope.isEnabled -or $scope.type -cne 'User') { throw 'Existing access_as_user scope must be enabled and delegated (type User). Resolve it manually.' }
    }
    Assert-WorkbenchIdentityGuid $scope.id 'Delegated scope ID'
    $roles = @((Get-WorkbenchIdentityValue $api 'appRoles') | Where-Object { $null -ne $_ })
    foreach ($roleName in @('reviewer', 'manager', 'auditor')) {
        $matchingRoles = @($roles | Where-Object { $_.value -ceq $roleName })
        if ($matchingRoles.Count -gt 1) { throw "Managed API has ambiguous $roleName roles." }
        if ($matchingRoles.Count -eq 0) {
            $roles += @{
                id = [guid]::NewGuid().ToString('D'); value = $roleName; displayName = $roleName
                description = "Scorecard workbench $roleName"; allowedMemberTypes = @('User'); isEnabled = $true
            }
        } elseif (-not $matchingRoles[0].isEnabled -or
            -not (Test-WorkbenchIdentityShape @($matchingRoles[0].allowedMemberTypes) @('User'))) {
            throw "Existing $roleName role must be enabled for User members only. Resolve it manually."
        }
    }
    foreach ($role in $roles) { Assert-WorkbenchIdentityGuid $role.id 'App role ID' }
    $preauthorizations = @((Get-WorkbenchIdentityValue $apiProperties 'preAuthorizedApplications') | Where-Object { $null -ne $_ })
    $preauthorized = @($preauthorizations | Where-Object { $_.appId -eq $spa.appId })
    if ($preauthorized.Count -gt 1) { throw 'Managed API has ambiguous SPA preauthorization entries.' }
    if ($preauthorized.Count -eq 0) {
        $preauthorizations += @{ appId = $spa.appId; delegatedPermissionIds = @($scope.id) }
    } elseif (@($preauthorized[0].delegatedPermissionIds) -notcontains $scope.id) {
        $entry = Copy-WorkbenchIdentityMap $preauthorized[0]
        $entry['delegatedPermissionIds'] = @($entry.delegatedPermissionIds) + @($scope.id)
        $preauthorizations = @($preauthorizations | ForEach-Object { if ($_.appId -eq $spa.appId) { $entry } else { $_ } })
    }
    $apiProperties['oauth2PermissionScopes'] = $scopes
    $apiProperties['preAuthorizedApplications'] = $preauthorizations
    $apiProperties['requestedAccessTokenVersion'] = 2
    $identifierUris = @((Get-WorkbenchIdentityValue $api 'identifierUris') | Where-Object { $null -ne $_ })
    if ($identifierUris -notcontains "api://$($api.appId)") { $identifierUris += "api://$($api.appId)" }
    $api = Set-WorkbenchApplication $api @{ api = $apiProperties; appRoles = $roles; identifierUris = $identifierUris }
    $requiredAccess = @(@{ resourceAppId = $api.appId; resourceAccess = @(@{ id = $scope.id; type = 'Scope' }) })
    $existingAccess = @((Get-WorkbenchIdentityValue $spa 'requiredResourceAccess') | Where-Object { $null -ne $_ })
    if ($existingAccess.Count -gt 0 -and -not (Test-WorkbenchIdentityShape $existingAccess $requiredAccess)) {
        throw 'Managed SPA requests permissions other than this API delegated scope. Resolve these manually; this hook never adds Graph/application permissions or overwrites unrelated permissions.'
    }
    foreach ($application in @($api, $spa)) {
        $web = Copy-WorkbenchIdentityMap (Get-WorkbenchIdentityValue $application 'web')
        $web['implicitGrantSettings'] = @{ enableAccessTokenIssuance = $false; enableIdTokenIssuance = $false }
        $desired = @{ web = $web; isFallbackPublicClient = $false }
        if ($application.id -eq $spa.id) { $desired['requiredResourceAccess'] = $requiredAccess }
        $null = Set-WorkbenchApplication $application $desired
    }
    $apiPrincipal = Get-WorkbenchServicePrincipal $api.appId
    $null = Get-WorkbenchServicePrincipal $spa.appId
    Assert-WorkbenchIdentityGuid $apiPrincipal.id 'API service principal object ID'
    $manager = @($api.appRoles | Where-Object { $_.value -ceq 'manager' })[0]
    # Application updates can take time to reach the resource service principal.
    $null = Confirm-WorkbenchServicePrincipalRole $api.appId $manager
    $assignmentPath = "servicePrincipals/$($apiPrincipal.id)/appRoleAssignedTo"
    $filter = "principalId eq $operatorId and appRoleId eq $($manager.id)"
    $assignments = @(Get-WorkbenchGraphMatches $assignmentPath $filter)
    if ($assignments.Count -eq 0) {
        $null = Invoke-WorkbenchGraph -Method POST -Path $assignmentPath -Body @{
            principalId = $operatorId; resourceId = $apiPrincipal.id; appRoleId = $manager.id
        }
    }
    for ($attempt = 0; $attempt -lt 4; $attempt++) {
        $assignments = @(Get-WorkbenchGraphMatches $assignmentPath $filter)
        if (@($assignments | Where-Object {
            $_.principalId -eq $operatorId -and $_.resourceId -eq $apiPrincipal.id -and $_.appRoleId -eq $manager.id
        }).Count -eq 1) { return $values }
        if ($attempt -lt 3) { Start-Sleep -Seconds ($attempt + 1) }
    }
    throw 'Operator manager app-role assignment readback mismatch. Verify existing directory permissions and retry azd up.'
}

function Confirm-WorkbenchServicePrincipalRole {
    param([string]$ClientId, [System.Collections.IDictionary]$Role)
    for ($attempt = 0; $attempt -lt 4; $attempt++) {
        $principals = @(Get-WorkbenchGraphMatches 'servicePrincipals' "appId eq '$ClientId'")
        if ($principals.Count -eq 1 -and @((Get-WorkbenchIdentityValue $principals[0] 'appRoles') | Where-Object {
            $_.id -eq $Role.id -and $_.value -ceq 'manager' -and $_.isEnabled -and
            (Test-WorkbenchIdentityShape @($_.allowedMemberTypes) @('User'))
        }).Count -eq 1) { return $principals[0] }
        if ($attempt -lt 3) { Start-Sleep -Seconds ($attempt + 1) }
    }
    throw 'API service principal manager role has not propagated. Retry azd up; no user assignment was attempted.'
}

function Complete-WorkbenchIdentity {
    param(
        [Parameter(Mandatory)][System.Collections.IDictionary]$Settings,
        [Parameter(Mandatory)][string]$AppUrl
    )
    if (-not (Test-WorkbenchAutomaticIdentity)) {
        Write-Host 'Automatic Entra setup disabled. Register the deployed HTTPS origin plus /auth/callback as a SPA redirect URI manually.'
        return
    }
    $subscription = Get-Setting 'AZURE_SUBSCRIPTION_ID'
    $target = Get-WorkbenchIdentityTarget -Settings $Settings -SubscriptionId $subscription
    $uri = $null
    if (-not [uri]::TryCreate($AppUrl, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -cne 'https' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/') {
        throw 'AppUrl must be an absolute HTTPS origin without credentials, path, query or fragment.'
    }
    $callback = "$($uri.GetLeftPart([UriPartial]::Authority))/auth/callback"
    $spaId = [string](Get-WorkbenchIdentityValue $Settings 'entraClientId')
    Assert-WorkbenchIdentityGuid $spaId 'ENTRA_CLIENT_ID'
    $spa = Find-WorkbenchApplication $target 'spa' $spaId
    if ($null -eq $spa) { throw 'Managed SPA is missing. Run identity initialization before registering its callback.' }
    $spaProperties = Copy-WorkbenchIdentityMap (Get-WorkbenchIdentityValue $spa 'spa')
    $redirects = @((Get-WorkbenchIdentityValue $spaProperties 'redirectUris') | Where-Object { $null -ne $_ })
    if ($redirects -cnotcontains $callback) { $redirects += $callback }
    $spaProperties['redirectUris'] = $redirects
    $null = Set-WorkbenchApplication $spa @{ spa = $spaProperties }
}
