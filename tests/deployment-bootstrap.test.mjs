import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = resolve(root, 'infra/hooks/bootstrap.ps1').replaceAll("'", "''");
const environment = {
  AZD_NON_INTERACTIVE: 'true', CI: '',
  AZURE_TENANT_ID: '11111111-1111-1111-1111-111111111111',
  AZURE_SUBSCRIPTION_ID: '22222222-2222-2222-2222-222222222222',
  AZURE_ENV_NAME: 'bootstraptest', AZURE_LOCATION: 'swedencentral',
  ENTRA_AUDIENCE: '', ENTRA_CLIENT_ID: '', ENTRA_API_SCOPE: '',
  AZURE_PRINCIPAL_ID: '', AZURE_PRINCIPAL_TYPE: '',
  CONTENT_UNDERSTANDING_SETUP_PRINCIPAL_ID: '', CONTENT_UNDERSTANDING_SETUP_PRINCIPAL_TYPE: '',
  DEPLOY_CONTENT_UNDERSTANDING: '', DEPLOY_OPENAI: '',
};
const identity = `
  function Initialize-WorkbenchIdentity {
    param($Settings, $SubscriptionId)
    if (-not $script:verified -or $SubscriptionId -ne $env:AZURE_SUBSCRIPTION_ID) { throw 'Unverified identity mutation' }
    return @{
      ENTRA_AUDIENCE = '33333333-3333-3333-3333-333333333333'
      ENTRA_CLIENT_ID = '44444444-4444-4444-4444-444444444444'
      ENTRA_API_SCOPE = 'api://33333333-3333-3333-3333-333333333333/access_as_user'
      AZURE_PRINCIPAL_ID = '55555555-5555-5555-5555-555555555555'
    }
  }
`;
function run(body, overrides = {}) {
  return spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `
    . '${script}'
    $script:verified = $false
    function Invoke-AzJson {
      param($Arguments)
      if (($Arguments -join ' ') -eq 'ad signed-in-user show') { return @{ id = '55555555-5555-5555-5555-555555555555' } }
      throw 'UNEXPECTED_LIVE_COMMAND'
    }
    function Assert-AzureContext {
      param($TenantId, $SubscriptionId)
      Assert-TargetIds $TenantId $SubscriptionId
      $script:verified = $true
      return @{ user = @{ type = 'user' } }
    }
    ${identity}
    ${body}
  `], { cwd: root, encoding: 'utf8', env: { ...process.env, ...environment, ...overrides } });
}

test('one-command bootstrap persists complete identity before provisioning without leaking CLI output into settings', () => {
  const result = run(`
    $script:commands = [Collections.Generic.List[object]]::new()
    function azd {
      $script:commands.Add(@($args))
      'CLI progress output'
      $global:LASTEXITCODE = 0
    }
    $settings = Initialize-WorkbenchDeployment -PersistAzd
    if ($settings -isnot [Collections.IDictionary] -or -not $settings.deployContentUnderstanding -or
        -not $settings.deployOpenAI -or $settings.entraAudience -ne $env:ENTRA_AUDIENCE) { throw 'Incomplete default bootstrap' }
    foreach ($name in @('AZURE_TENANT_ID', 'AZURE_SUBSCRIPTION_ID', 'AZURE_LOCATION',
        'ENTRA_AUDIENCE', 'ENTRA_CLIENT_ID', 'ENTRA_API_SCOPE', 'AZURE_PRINCIPAL_ID', 'CONTENT_UNDERSTANDING_SETUP_PRINCIPAL_ID')) {
      if (@($script:commands | Where-Object { $_[0] -eq 'env' -and $_[1] -eq 'set' -and $_[2] -eq $name }).Count -ne 1) {
        throw "Missing or duplicate persisted setting $name"
      }
    }
    $auth = @($script:commands | Where-Object { $_[0] -eq 'auth' })[0]
    if ($auth -notcontains '--check-status' -or $auth[-1] -ne $env:AZURE_TENANT_ID) { throw 'azd authentication was not tenant-specific' }
  `);
  assert.equal(result.status, 0, result.stderr);
});

test('non-interactive missing or denied target fails before identity creation or login', () => {
  for (const overrides of [
    { AZURE_TENANT_ID: '' },
    { AZURE_SUBSCRIPTION_ID: '' },
    { AZURE_TENANT_ID: 'not-a-guid' },
    { AZURE_ENV_NAME: 'Invalid-Environment' },
  ]) {
    const result = run(`
      function Initialize-WorkbenchIdentity { throw 'UNEXPECTED_IDENTITY_MUTATION' }
      function azd { throw 'UNEXPECTED_LOGIN' }
      try { Initialize-WorkbenchDeployment -PersistAzd; exit 7 }
      catch {
        if ($_.Exception.Message -like '*UNEXPECTED_*') { throw }
        exit 0
      }
    `, overrides);
    assert.equal(result.status, 0, `${JSON.stringify(overrides)}\n${result.stderr}`);
  }
});

test('wrong ambient context cannot start non-interactive sign-in or mutate directory state', () => {
  const result = run(`
    function Assert-AzureContext { throw 'Wrong explicit target' }
    function Initialize-WorkbenchIdentity { throw 'UNEXPECTED_IDENTITY_MUTATION' }
    function azd { throw 'UNEXPECTED_LOGIN' }
    try { Initialize-WorkbenchDeployment -PersistAzd; exit 7 }
    catch { if ($_.Exception.Message -ne 'Wrong explicit target') { throw }; exit 0 }
  `);
  assert.equal(result.status, 0, result.stderr);
});

test('explicit cloud capability opt-outs remain effective in one-command deployment', () => {
  const result = run(`
    $settings = Initialize-WorkbenchDeployment
    if ($settings.deployContentUnderstanding -or $settings.deployOpenAI) { throw 'Explicit opt-out was ignored' }
    if ($settings.entraClientId -ne '44444444-4444-4444-4444-444444444444') { throw 'Identity setup was skipped' }
  `, { DEPLOY_CONTENT_UNDERSTANDING: 'false', DEPLOY_OPENAI: 'false' });
  assert.equal(result.status, 0, result.stderr);
});

test('azd reserved principal cannot redirect CU setup access away from the Azure CLI caller', () => {
  const result = run(`
    function azd { $global:LASTEXITCODE = 0 }
    $settings = Initialize-WorkbenchDeployment -PersistAzd
    if ($settings.contentUnderstandingSetupPrincipalId -ne '55555555-5555-5555-5555-555555555555') {
      throw 'CU setup access was assigned to the wrong CLI identity'
    }
    if ($env:CONTENT_UNDERSTANDING_SETUP_PRINCIPAL_TYPE -ne 'User') { throw 'Setup caller type drifted' }
  `, { AZURE_PRINCIPAL_ID: '66666666-6666-6666-6666-666666666666' });
  assert.equal(result.status, 0, result.stderr);
});
