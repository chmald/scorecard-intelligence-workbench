import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const hooks = resolve(root, 'infra/hooks');
const environment = {
  AZURE_ENV_NAME: 'identitytest',
  AZURE_TENANT_ID: '11111111-1111-1111-1111-111111111111',
  AZURE_SUBSCRIPTION_ID: '22222222-2222-2222-2222-222222222222',
  AUTO_CONFIGURE_ENTRA: '',
  ENTRA_AUDIENCE: '', ENTRA_CLIENT_ID: '', ENTRA_API_SCOPE: '',
  AZURE_PRINCIPAL_ID: '', AZURE_PRINCIPAL_TYPE: '',
};

// All CLI calls are intercepted in memory. An unexpected command cannot reach az.
const harness = `
  . ${quote(resolve(hooks, 'common.ps1'))}
  . ${quote(resolve(hooks, 'identity.ps1'))}
  function az { throw 'REAL_AZURE_IS_FORBIDDEN' }
  function Start-Sleep { param($Seconds) }
  function Assert($Condition, $Message) { if (-not $Condition) { throw $Message } }
  function Clone($Value) { return ($Value | ConvertTo-Json -Depth 100 | ConvertFrom-Json -AsHashtable) }
  $script:applications = [Collections.Generic.List[object]]::new()
  $script:principals = [Collections.Generic.List[object]]::new()
  $script:assignments = [Collections.Generic.List[object]]::new()
  $script:mutations = [Collections.Generic.List[object]]::new()
  $script:bodyPaths = [Collections.Generic.List[string]]::new()
  $script:graphReads = 0
  $script:wrongTenant = $false
  $script:mismatch = $false
  $script:redirectMismatch = $false
  $script:assignmentMismatch = $false
  $script:denyAssignment = $false
  $script:failSpaCreation = $false
  $script:nextLink = $false
  $script:operatorId = '55555555-5555-5555-5555-555555555555'

  function Invoke-AzJson {
    param([string[]]$Arguments)
    if ($Arguments[0] -eq 'account' -and $Arguments[1] -eq 'show') {
      return @{
        tenantId = $(if ($script:wrongTenant) { 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' } else { $env:AZURE_TENANT_ID })
        id = $env:AZURE_SUBSCRIPTION_ID
      }
    }
    Assert ($Arguments[0] -eq 'rest') 'Unexpected Azure CLI command'
    $method = $Arguments[[array]::IndexOf($Arguments, '--method') + 1]
    $url = [uri]$Arguments[[array]::IndexOf($Arguments, '--url') + 1]
    Assert ($url.Scheme -eq 'https' -and $url.Host -eq 'graph.microsoft.com') 'Unexpected Graph host'
    Assert ($url.AbsolutePath.StartsWith('/v1.0/')) 'Only Graph v1.0 is allowed'
    $path = $url.AbsolutePath.Substring(6)
    $filter = [uri]::UnescapeDataString([regex]::Match($url.Query, '\\$filter=([^&]+)').Groups[1].Value)
    $body = $null
    if ($method -ne 'GET') {
      $bodyArgument = $Arguments[[array]::IndexOf($Arguments, '--body') + 1]
      Assert ($bodyArgument.StartsWith('@')) 'Graph body must use a named JSON file'
      $bodyPath = $bodyArgument.Substring(1)
      Assert ($bodyPath.EndsWith('.json') -and (Test-Path -LiteralPath $bodyPath)) 'Missing JSON request file'
      Assert ((Split-Path $bodyPath -Parent) -eq ${quote(hooks)}) 'Request file outside hooks directory'
      $script:bodyPaths.Add($bodyPath)
      $body = Get-Content -LiteralPath $bodyPath -Raw | ConvertFrom-Json -AsHashtable
      $script:mutations.Add(@{ method = $method; path = $path; body = (Clone $body) })
    } else { $script:graphReads++ }
    if ($path -eq 'me') { return @{ id = $script:operatorId } }
    if ($path -eq 'applications' -and $method -eq 'GET') {
      Assert ($url.Query -match '\\$top=2') 'Unbounded application lookup'
      $matches = @()
      if ($filter -match "^displayName eq '([^']+)'$") {
        $name = $Matches[1]
        $matches = @($script:applications | Where-Object { $_.displayName -ceq $name })
      } elseif ($filter -match "^appId eq '([^']+)'$") {
        $id = $Matches[1]
        $matches = @($script:applications | Where-Object { $_.appId -eq $id })
      } else { throw "Unscoped application lookup: $filter" }
      $result = @{ value = @($matches | ForEach-Object { Clone $_ }) }
      if ($script:nextLink) { $result['@odata.nextLink'] = 'https://graph.microsoft.com/v1.0/applications?$skiptoken=unread' }
      return $result
    }
    if ($path -eq 'applications' -and $method -eq 'POST') {
      if ($body.displayName.EndsWith('-spa') -and $script:failSpaCreation) {
        $script:failSpaCreation = $false
        throw 'Simulated partial failure creating SPA'
      }
      $app = Clone $body
      $app['id'] = [guid]::NewGuid().ToString()
      $app['appId'] = [guid]::NewGuid().ToString()
      $app['api'] = @{}
      $app['appRoles'] = @()
      $app['identifierUris'] = @()
      $app['requiredResourceAccess'] = @()
      if (-not $app.Contains('spa')) { $app['spa'] = @{ redirectUris = @() } }
      $script:applications.Add($app)
      return Clone $app
    }
    if ($path -match '^applications/([^/]+)$') {
      $id = $Matches[1]
      $app = @($script:applications | Where-Object { $_.id -eq $id })[0]
      if ($method -eq 'PATCH') {
        foreach ($key in $body.Keys) { $app[$key] = $body[$key] }
        return
      }
      $copy = Clone $app
      if ($script:mismatch) { $copy.api['requestedAccessTokenVersion'] = 1 }
      if ($script:redirectMismatch) { $copy.spa['redirectUris'] = @() }
      return $copy
    }
    if ($path -eq 'servicePrincipals' -and $method -eq 'GET') {
      Assert ($filter -match "^appId eq '([^']+)'$") 'Unbounded service principal lookup'
      $id = $Matches[1]
      $items = @($script:principals | Where-Object { $_.appId -eq $id } | ForEach-Object {
        $copy = Clone $_
        $copy['appRoles'] = @(@($script:applications | Where-Object { $_.appId -eq $id })[0].appRoles)
        $copy
      })
      return @{ value = $items }
    }
    if ($path -eq 'servicePrincipals' -and $method -eq 'POST') {
      Assert ($body.Count -eq 1 -and $body.Contains('appId')) 'Unexpected service principal properties'
      $principal = @{ id = [guid]::NewGuid().ToString(); appId = $body.appId }
      $script:principals.Add($principal)
      return Clone $principal
    }
    if ($path -match '^servicePrincipals/([^/]+)/appRoleAssignedTo$') {
      $resourceId = $Matches[1]
      if ($method -eq 'GET') {
        Assert ($filter -match '^principalId eq ([a-f0-9-]+) and appRoleId eq ([a-f0-9-]+)$') 'Unbounded assignment lookup'
        $principalId = $Matches[1]; $roleId = $Matches[2]
        if ($script:assignmentMismatch) { return @{ value = @() } }
        return @{ value = @($script:assignments | Where-Object {
          $_.resourceId -eq $resourceId -and $_.principalId -eq $principalId -and $_.appRoleId -eq $roleId
        } | ForEach-Object { Clone $_ }) }
      }
      Assert ($body.principalId -eq $script:operatorId) 'Assigned someone other than current operator'
      Assert ($body.resourceId -eq $resourceId) 'Assignment resource mismatch'
      if ($script:denyAssignment) { throw 'Authorization_RequestDenied' }
      $script:assignments.Add((Clone $body))
      return Clone $body
    }
    throw "Unexpected Graph operation: $method $path"
  }
  function Initialize {
    return Initialize-WorkbenchIdentity -Settings (Get-DeploymentSettings) -SubscriptionId $env:AZURE_SUBSCRIPTION_ID
  }
  function Expect-Failure([scriptblock]$Action, [string]$Pattern) {
    $failed = $false
    try { $null = & $Action } catch {
      $failed = $true
      Assert ($_.Exception.Message -like $Pattern) "Unexpected failure: $($_.Exception.Message)"
    }
    Assert $failed "Expected failure matching $Pattern"
  }
`;

function run(script, env = {}) {
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `${harness}\n${script}\n
    foreach ($path in $script:bodyPaths) { Assert (-not (Test-Path -LiteralPath $path)) 'Request file leaked' }
    Write-Output 'IDENTITY_TEST_OK'
  `], {
    cwd: root, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, ...environment, ...env },
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /IDENTITY_TEST_OK/);
  assert.equal(readdirSync(hooks).some((name) => name.startsWith('.identity-request-')), false);
}

test('creates managed single-tenant API and public SPA, then reuses with no mutations', () => {
  run(`
    $values = Initialize
    Assert ($values -is [hashtable]) 'Initialization must return a hashtable'
    Assert ($script:applications.Count -eq 2 -and $script:principals.Count -eq 2) 'Expected exactly two apps and service principals'
    Assert ($values.ENTRA_AUDIENCE -eq $env:ENTRA_AUDIENCE -and $values.ENTRA_CLIENT_ID -eq $env:ENTRA_CLIENT_ID) 'Client IDs not persisted'
    Assert ($values.ENTRA_API_SCOPE -eq "api://$($values.ENTRA_AUDIENCE)/access_as_user") 'Unexpected API scope'
    Assert ($values.AZURE_PRINCIPAL_ID -eq $script:operatorId) 'Operator ID not persisted'
    $api = @($script:applications | Where-Object { $_.appId -eq $values.ENTRA_AUDIENCE })[0]
    $spa = @($script:applications | Where-Object { $_.appId -eq $values.ENTRA_CLIENT_ID })[0]
    foreach ($app in @($api, $spa)) {
      Assert ($app.signInAudience -eq 'AzureADMyOrg' -and $app.tags.Count -eq 1) 'Missing ownership/single-tenant boundary'
      Assert (-not $app.web.implicitGrantSettings.enableAccessTokenIssuance -and -not $app.web.implicitGrantSettings.enableIdTokenIssuance) 'Implicit flow enabled'
      Assert (-not $app.Contains('passwordCredentials') -and -not $app.Contains('keyCredentials')) 'Created credentials'
    }
    Assert ($api.api.requestedAccessTokenVersion -eq 2) 'API does not issue v2 tokens'
    $scope = @($api.api.oauth2PermissionScopes)[0]
    Assert ($scope.value -eq 'access_as_user' -and $scope.type -eq 'User' -and $scope.isEnabled) 'Incorrect delegated scope'
    Assert ($api.appRoles.Count -eq 3) 'Incorrect role set'
    foreach ($role in $api.appRoles) {
      Assert ($role.value -in @('reviewer', 'manager', 'auditor') -and $role.isEnabled -and
        $role.allowedMemberTypes.Count -eq 1 -and $role.allowedMemberTypes[0] -eq 'User') 'Unsafe app role'
    }
    Assert ($spa.requiredResourceAccess.Count -eq 1 -and $spa.requiredResourceAccess[0].resourceAppId -eq $api.appId) 'Unexpected requested API permissions'
    Assert ($spa.requiredResourceAccess[0].resourceAccess.Count -eq 1 -and $spa.requiredResourceAccess[0].resourceAccess[0].type -eq 'Scope' -and
      $spa.requiredResourceAccess[0].resourceAccess[0].id -eq $scope.id) 'Unexpected scope request'
    Assert ($api.api.preAuthorizedApplications.Count -eq 1 -and $api.api.preAuthorizedApplications[0].appId -eq $spa.appId) 'Unexpected preauthorization'
    $manager = @($api.appRoles | Where-Object { $_.value -eq 'manager' })[0]
    Assert ($script:assignments.Count -eq 1 -and $script:assignments[0].principalId -eq $script:operatorId -and
      $script:assignments[0].appRoleId -eq $manager.id) 'Manager role not assigned only to operator'
    $before = $script:mutations.Count
    $again = Initialize
    Assert ($script:mutations.Count -eq $before) 'Repeat initialization mutated Graph'
    Assert ($again.ENTRA_AUDIENCE -eq $values.ENTRA_AUDIENCE -and $again.ENTRA_CLIENT_ID -eq $values.ENTRA_CLIENT_ID) 'Identity IDs changed'
  `);
});

test('explicit infrastructure principal is preserved, but manager assignment remains current operator', () => {
  run(`
    $values = Initialize
    Assert ($values.AZURE_PRINCIPAL_ID -eq '99999999-9999-9999-9999-999999999999') 'Explicit principal was overwritten'
    Assert ($script:assignments[0].principalId -eq $script:operatorId) 'Infrastructure principal was assigned manager'
  `, { AZURE_PRINCIPAL_ID: '99999999-9999-9999-9999-999999999999' });
});

test('wrong ambient tenant fails before any Graph request in either export', () => {
  run(`
    $script:wrongTenant = $true
    Expect-Failure { Initialize } '*does not match*'
    Expect-Failure { Complete-WorkbenchIdentity (Get-DeploymentSettings) 'https://workbench.example.invalid' } '*does not match*'
    Assert ($script:graphReads -eq 0 -and $script:mutations.Count -eq 0) 'Graph was accessed in wrong tenant'
  `);
});

test('manual identity mode never calls Graph and leaves supplied configuration unchanged', () => {
  run(`
    $values = Initialize
    Complete-WorkbenchIdentity (Get-DeploymentSettings) 'https://workbench.example.invalid'
    Assert ($script:graphReads -eq 0 -and $script:mutations.Count -eq 0) 'Manual mode accessed Graph'
    Assert ($values.ENTRA_AUDIENCE -eq 'existing-api' -and $values.ENTRA_CLIENT_ID -eq 'existing-spa' -and $values.ENTRA_API_SCOPE -eq 'existing-scope') 'Manual configuration changed'
    Assert ($env:ENTRA_AUDIENCE -eq 'existing-api' -and $env:ENTRA_CLIENT_ID -eq 'existing-spa' -and $env:ENTRA_API_SCOPE -eq 'existing-scope') 'Manual process environment changed'
  `, { AUTO_CONFIGURE_ENTRA: 'false', ENTRA_AUDIENCE: 'existing-api', ENTRA_CLIENT_ID: 'existing-spa', ENTRA_API_SCOPE: 'existing-scope' });
});

test('unmanaged supplied IDs, unowned names, duplicate matches and incomplete pages are rejected', () => {
  run(`
    $env:ENTRA_AUDIENCE = '77777777-7777-7777-7777-777777777777'
    Expect-Failure { Initialize } '*AUTO_CONFIGURE_ENTRA=false*'
    Assert ($script:mutations.Count -eq 0) 'Created apps for unmanaged supplied IDs'
    $env:ENTRA_AUDIENCE = ''
    $values = Initialize
    $before = $script:mutations.Count
    $api = $script:applications[0]
    $savedTags = $api.tags
    $api.tags = @('some-other-owner')
    Expect-Failure { Initialize } '*lookalike*'
    $api.tags = $savedTags
    $duplicate = Clone $api
    $duplicate.id = [guid]::NewGuid().ToString()
    $script:applications.Add($duplicate)
    Expect-Failure { Initialize } '*Ambiguous*'
    $script:applications.RemoveAt(2)
    $script:nextLink = $true
    Expect-Failure { Initialize } '*Ambiguous*'
    Assert ($script:mutations.Count -eq $before) 'Collision mutated Graph'
  `);
});

test('partial creation failure is recoverable by deterministic lookup without duplicate API apps', () => {
  run(`
    $script:failSpaCreation = $true
    Expect-Failure { Initialize } '*Simulated partial failure*'
    Assert ($script:applications.Count -eq 1 -and $env:ENTRA_AUDIENCE) 'API identity was not saved before partial failure'
    $apiId = $env:ENTRA_AUDIENCE
    # Simulate another azd invocation before the parent could persist the failed hook's outputs.
    $env:ENTRA_AUDIENCE = ''; $env:ENTRA_CLIENT_ID = ''; $env:ENTRA_API_SCOPE = ''
    $null = Initialize
    Assert ($script:applications.Count -eq 2 -and $env:ENTRA_AUDIENCE -eq $apiId) 'Partial retry duplicated API'
    $before = $script:mutations.Count
    $null = Initialize
    Assert ($script:mutations.Count -eq $before) 'Completed retry was not idempotent'
  `);
});

test('sparse settings work under strict mode and invalid automatic setting fails closed', () => {
  run(`
    $settings = [ordered]@{ tenantId = $env:AZURE_TENANT_ID; environmentName = $env:AZURE_ENV_NAME }
    $values = Initialize-WorkbenchIdentity -Settings $settings -SubscriptionId $env:AZURE_SUBSCRIPTION_ID
    Assert ($values.ENTRA_AUDIENCE -and $values.ENTRA_CLIENT_ID) 'Missing optional dictionary keys prevented initialization'
    $before = $script:mutations.Count
    $env:AUTO_CONFIGURE_ENTRA = 'not-a-boolean'
    Expect-Failure { Initialize } '*must be true or false*'
    Assert ($script:mutations.Count -eq $before) 'Invalid automatic setting changed Graph'
  `);
});

test('application and role-assignment readback mismatches never report success', () => {
  run(`
    $script:mismatch = $true
    Expect-Failure { Initialize } '*readback mismatch*'
    $script:mismatch = $false
    $script:assignmentMismatch = $true
    Expect-Failure { Initialize } '*assignment readback mismatch*'
  `);
});

test('assignment permission denial is actionable and retry does not duplicate apps', () => {
  run(`
    $script:denyAssignment = $true
    Expect-Failure { Initialize } '*existing directory permission*'
    Assert ($script:assignments.Count -eq 0 -and $script:applications.Count -eq 2) 'Failed assignment reported as persisted'
    $script:denyAssignment = $false
    $null = Initialize
    Assert ($script:assignments.Count -eq 1 -and $script:applications.Count -eq 2) 'Permission recovery duplicated identities'
  `);
});

test('existing scopes, role IDs, preauthorizations, identifiers and unrelated fields survive repair', () => {
  run(`
    $null = Initialize
    $api = $script:applications[0]
    $oldScopeId = $api.api.oauth2PermissionScopes[0].id
    $oldManagerId = @($api.appRoles | Where-Object { $_.value -eq 'manager' })[0].id
    $extraScope = Clone $api.api.oauth2PermissionScopes[0]
    $extraScope.id = [guid]::NewGuid().ToString(); $extraScope.value = 'unrelated_scope'
    $api.api.oauth2PermissionScopes += $extraScope
    $extraRole = Clone $api.appRoles[0]
    $extraRole.id = [guid]::NewGuid().ToString(); $extraRole.value = 'unrelated_role'
    $api.appRoles += $extraRole
    $api.api['knownClientApplications'] = @('88888888-8888-8888-8888-888888888888')
    $api.api.preAuthorizedApplications += @{ appId = '88888888-8888-8888-8888-888888888888'; delegatedPermissionIds = @($extraScope.id) }
    $api.identifierUris += 'https://existing.example.invalid/api'
    $api['notes'] = 'preserve this'
    $api.api.requestedAccessTokenVersion = 1
    $null = Initialize
    Assert ($api.api.oauth2PermissionScopes.Count -eq 2 -and $api.api.oauth2PermissionScopes[0].id -eq $oldScopeId) 'Existing scopes lost'
    Assert ($api.appRoles.Count -eq 4 -and @($api.appRoles | Where-Object { $_.value -eq 'manager' })[0].id -eq $oldManagerId) 'Existing role IDs lost'
    Assert ($api.api.knownClientApplications.Count -eq 1 -and $api.api.preAuthorizedApplications.Count -eq 2) 'Unrelated API properties lost'
    Assert ($api.identifierUris -contains 'https://existing.example.invalid/api') 'Existing identifier lost'
    Assert ($api.notes -eq 'preserve this') 'Unrelated application property lost'
  `);
});

test('callback completion preserves redirects, verifies readback and is idempotent', () => {
  run(`
    $null = Initialize
    $spa = $script:applications[1]
    $spa.spa.redirectUris = @('http://localhost:3000/auth/callback', 'https://old.example.invalid/auth/callback')
    $before = $script:mutations.Count
    Complete-WorkbenchIdentity (Get-DeploymentSettings) 'https://workbench.example.invalid/'
    Assert ($script:mutations.Count -eq $before + 1) 'Expected one callback patch'
    Assert ($spa.spa.redirectUris.Count -eq 3 -and $spa.spa.redirectUris -contains 'http://localhost:3000/auth/callback' -and
      $spa.spa.redirectUris -contains 'https://old.example.invalid/auth/callback' -and
      $spa.spa.redirectUris -contains 'https://workbench.example.invalid/auth/callback') 'Redirect merge lost existing entries'
    $before = $script:mutations.Count
    Complete-WorkbenchIdentity (Get-DeploymentSettings) 'https://workbench.example.invalid'
    Assert ($script:mutations.Count -eq $before) 'Repeat callback completion mutated Graph'
    $script:redirectMismatch = $true
    Expect-Failure { Complete-WorkbenchIdentity (Get-DeploymentSettings) 'https://new.example.invalid' } '*readback mismatch*'
  `);
});

test('callback rejects unsafe URLs before Graph lookup or writes', () => {
  run(`
    foreach ($url in @('http://workbench.example.invalid', 'https://user:password@workbench.example.invalid',
      'https://workbench.example.invalid/path', 'https://workbench.example.invalid/?query=yes', 'https://workbench.example.invalid/#fragment')) {
      Expect-Failure { Complete-WorkbenchIdentity (Get-DeploymentSettings) $url } '*absolute HTTPS origin*'
    }
    Assert ($script:graphReads -eq 0 -and $script:mutations.Count -eq 0) 'Unsafe redirect made Graph requests'
  `);
});
