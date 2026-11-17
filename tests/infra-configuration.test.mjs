import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const main = read('infra/main.bicep');
const wrapper = read('infra/azd.bicep');
const parameters = JSON.parse(read('infra/azd.parameters.json')).parameters;
const psQuote = (value) => `'${value.replaceAll("'", "''")}'`;
const pwsh = (script, env = {}) => spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
  cwd: root, encoding: 'utf8', env: { ...process.env, ...env },
});
const sourceCommon = `. ${psQuote(resolve(root, 'infra/hooks/common.ps1'))}; `;
const validEnvironment = {
  AZURE_ENV_NAME: 'guardtest', AZURE_LOCATION: 'operator-selected-region',
  AZURE_TENANT_ID: '11111111-1111-1111-1111-111111111111',
  AZURE_SUBSCRIPTION_ID: '22222222-2222-2222-2222-222222222222',
  ENTRA_AUDIENCE: '33333333-3333-3333-3333-333333333333', AZURE_RESOURCE_GROUP: '',
  ENTRA_CLIENT_ID: '44444444-4444-4444-4444-444444444444',
  ENTRA_API_SCOPE: 'api://33333333-3333-3333-3333-333333333333/access_as_user',
  DEPLOY_OPENAI: 'false', DEPLOY_CONTENT_UNDERSTANDING: 'false',
  AZURE_OPENAI_MODEL_NAME: '', AZURE_OPENAI_MODEL_VERSION: '',
  AZURE_OPENAI_DEPLOYMENT: '', AZURE_OPENAI_DEPLOYMENT_SKU: '',
};
const contentEnvironment = {
  DEPLOY_CONTENT_UNDERSTANDING: 'true', CONTENT_UNDERSTANDING_LOCATION: 'operator-content-region',
  CONTENT_UNDERSTANDING_ANALYZER_ID: 'document_metrics',
  CONTENT_UNDERSTANDING_COMPLETION_MODEL: 'operator-completion-model',
  CONTENT_UNDERSTANDING_COMPLETION_MODEL_VERSION: 'operator-completion-version',
  CONTENT_UNDERSTANDING_COMPLETION_DEPLOYMENT: 'operator-completion',
  CONTENT_UNDERSTANDING_COMPLETION_DEPLOYMENT_SKU: 'operator-completion-sku',
  CONTENT_UNDERSTANDING_COMPLETION_CAPACITY: '2',
  CONTENT_UNDERSTANDING_EMBEDDING_MODEL: 'operator-embedding-model',
  CONTENT_UNDERSTANDING_EMBEDDING_MODEL_VERSION: 'operator-embedding-version',
  CONTENT_UNDERSTANDING_EMBEDDING_DEPLOYMENT: 'operator-embedding',
  CONTENT_UNDERSTANDING_EMBEDDING_DEPLOYMENT_SKU: 'operator-embedding-sku',
  CONTENT_UNDERSTANDING_EMBEDDING_CAPACITY: '3',
  AZURE_PRINCIPAL_ID: '55555555-5555-5555-5555-555555555555', AZURE_PRINCIPAL_TYPE: 'User',
};

test('subscription wrapper forwards every shared parameter and exposes every output', () => {
  for (const [, name] of main.matchAll(/^param (\w+) /gm)) {
    assert.match(wrapper, new RegExp(`^param ${name} `, 'm'), `wrapper parameter ${name}`);
    assert.match(wrapper, new RegExp(`^\\s+${name}: ${name}$`, 'm'), `forwarded ${name}`);
    assert.ok(parameters[name], `azd substitution ${name}`);
  }
  for (const [, name] of main.matchAll(/^output (\w+) /gm)) {
    assert.match(name, /^[A-Z][A-Z0-9_]+$/);
    assert.match(wrapper, new RegExp(`^output ${name} string = resources.outputs.${name}$`, 'm'));
  }
  for (const [name, setting] of Object.entries(parameters)) {
    assert.equal(typeof setting.value, 'string', `${name} substitution must be quoted`);
    assert.match(setting.value, /^\$\{[^{}]+\}$/, `${name} cannot nest substitutions`);
  }
});

test('cloud state and authorization are managed-identity backed and never local-role based', () => {
  assert.match(main, /name: 'AUTH_MODE', value: 'entra'/);
  for (const name of ['AZURE_CLIENT_ID', 'COSMOS_ENDPOINT', 'COSMOS_DATABASE', 'COSMOS_CONTAINER', 'ENTRA_AUDIENCE', 'ENTRA_CLIENT_ID', 'ENTRA_API_SCOPE']) {
    assert.match(main, new RegExp(`name: '${name}'`));
  }
  assert.match(main, /sqlRoleDefinitions\/00000000-0000-0000-0000-000000000002/);
  assert.match(main, /paths: \[\s+'\/id'/);
  assert.match(main, /minReplicas: 1\s+maxReplicas: 1/);
  assert.doesNotMatch(main, /AzureFile|sqlite|ROLE_OVERRIDE|DEMO_ROLE|Microsoft.Graph\/applications/i);
  assert.match(main, /roleAssignmentMode: 'LegacyRegistryPermissions'/);
  assert.match(main, /a97b65f3-24c7-4388-baec-2e87135dc908/);
  assert.match(main, /5e0bd9bd-7b93-4f28-af87-19fc36ad61bd/);
});

test('Content Understanding uses a dedicated keyless AI Services account and two explicit model deployments', () => {
  assert.match(main, /param deployContentUnderstanding bool = false/);
  assert.match(main, /param contentUnderstandingAnalyzerId string = 'document_metrics'/);
  assert.match(main, /resource contentUnderstanding 'Microsoft\.CognitiveServices\/accounts@2026-09-01' = if \(deployContentUnderstanding\)/);
  assert.match(main, /kind: 'AIServices'/);
  assert.match(main, /customSubDomainName: 'cu-\$\{suffix\}'\s+disableLocalAuth: true/);
  assert.doesNotMatch(main + wrapper + JSON.stringify(parameters) + read('infra/deploy-manual.ps1'), /FormRecognizer|DocumentIntelligence|DOCUMENT_INTELLIGENCE/);
  for (const kind of ['Completion', 'Embedding']) {
    const symbol = `content${kind}`;
    assert.match(main, new RegExp(`resource ${symbol} 'Microsoft.CognitiveServices/accounts/deployments@2026-09-01' = if \\(deployContentUnderstanding\\) \\{\\s+parent: contentUnderstanding\\s+name: contentUnderstanding${kind}DeploymentName`));
    for (const field of ['ModelName', 'ModelVersion', 'DeploymentName', 'DeploymentSku', 'Capacity']) {
      assert.match(main, new RegExp(`contentUnderstanding${kind}${field}`));
    }
  }
  assert.match(main, /resource contentSetup[\s\S]+principalId: contentUnderstandingSetupPrincipalId\s+principalType: contentUnderstandingSetupPrincipalType\s+roleDefinitionId: cognitiveUserRole/);
  assert.match(main, /resource contentReader[\s\S]+principalId: identity.properties.principalId\s+principalType: 'ServicePrincipal'\s+roleDefinitionId: cognitiveUserRole/);
  assert.doesNotMatch(main, /contentUnderstanding\/analyzers|accounts\/analyzers/);
});

test('bad names, missing targets/audience and unspecified live model choices fail before Azure', () => {
  const cases = [
    { AZURE_ENV_NAME: 'Invalid-Name' },
    { AZURE_TENANT_ID: '' },
    { AZURE_SUBSCRIPTION_ID: '' },
    { ENTRA_AUDIENCE: '' },
    { ENTRA_AUDIENCE: 'api://33333333-3333-3333-3333-333333333333' },
    { ENTRA_CLIENT_ID: '' },
    { ENTRA_CLIENT_ID: 'not-an-application-id' },
    { ENTRA_API_SCOPE: '' },
    { ENTRA_API_SCOPE: 'https://graph.microsoft.com/User.Read' },
    { ENTRA_API_SCOPE: 'api://different-api/access_as_user' },
    { DEPLOY_OPENAI: 'true' },
    { DEPLOY_OPENAI: 'not-a-bool' },
    { COSMOS_THROUGHPUT: '401' },
  ];
  for (const overrides of cases) {
    const result = pwsh(`${sourceCommon}
      function Invoke-AzJson { throw 'UNEXPECTED_AZURE_CALL' }
      try { Assert-DeploymentConfiguration (Get-DeploymentSettings); exit 7 }
      catch { if ($_.Exception.Message -like '*UNEXPECTED_AZURE_CALL*') { exit 8 }; exit 0 }
    `, { ...validEnvironment, ...overrides });
    assert.equal(result.status, 0, `${JSON.stringify(overrides)}\n${result.stderr}`);
  }
});

test('Content Understanding requires explicit model selections and setup identity before any Azure operation', () => {
  const overrides = [
    { DEPLOY_CONTENT_UNDERSTANDING: 'invalid' },
    ...Object.keys(contentEnvironment).filter((name) => /MODEL|DEPLOYMENT|PRINCIPAL_ID/.test(name)).map((name) => ({ [name]: '' })),
    { AZURE_PRINCIPAL_ID: '00000000-0000-0000-0000-000000000000' },
    { AZURE_PRINCIPAL_TYPE: 'Owner' },
    { CONTENT_UNDERSTANDING_COMPLETION_CAPACITY: '0' },
    { CONTENT_UNDERSTANDING_EMBEDDING_CAPACITY: '-1' },
    { CONTENT_UNDERSTANDING_ANALYZER_ID: 'invalid/id' },
    { CONTENT_UNDERSTANDING_EMBEDDING_DEPLOYMENT: 'operator-completion' },
    { CONTENT_UNDERSTANDING_EMBEDDING_MODEL: 'operator-completion-model' },
  ];
  for (const invalid of overrides) {
    const result = pwsh(`${sourceCommon}
      function Invoke-AzJson { throw 'UNEXPECTED_AZURE_CALL' }
      try { Assert-DeploymentConfiguration (Get-DeploymentSettings); exit 7 }
      catch { if ($_.Exception.Message -like '*UNEXPECTED_AZURE_CALL*') { exit 8 }; exit 0 }
    `, { ...validEnvironment, ...contentEnvironment, ...invalid });
    assert.equal(result.status, 0, `${JSON.stringify(invalid)}\n${result.stderr}`);
  }
  const result = pwsh(`${sourceCommon}
    $settings = Get-DeploymentSettings
    Assert-DeploymentConfiguration $settings
    if ($settings.contentUnderstandingCompletionCapacity -ne 2 -or $settings.contentUnderstandingEmbeddingCapacity -ne 3 -or
        $settings.contentUnderstandingLocation -ne 'operator-content-region' -or
        $settings.contentUnderstandingSetupPrincipalId -ne $env:AZURE_PRINCIPAL_ID) { throw 'Content Understanding configuration changed' }
  `, { ...validEnvironment, ...contentEnvironment });
  assert.equal(result.status, 0, result.stderr);
});

test('explicit live model settings survive validation without being silently rewritten', () => {
  const result = pwsh(`${sourceCommon}
    $settings = Get-DeploymentSettings
    Assert-DeploymentConfiguration $settings
    if ($settings.openAIModelName -ne 'operator-model' -or $settings.openAIModelVersion -ne 'operator-version' -or
        $settings.openAIDeploymentName -ne 'operator-deployment' -or $settings.openAIDeploymentSku -ne 'operator-sku') { throw 'Model choice changed' }
  `, { ...validEnvironment, DEPLOY_OPENAI: 'true', AZURE_OPENAI_MODEL_NAME: 'operator-model',
    AZURE_OPENAI_MODEL_VERSION: 'operator-version', AZURE_OPENAI_DEPLOYMENT: 'operator-deployment',
    AZURE_OPENAI_DEPLOYMENT_SKU: 'operator-sku' });
  assert.equal(result.status, 0, result.stderr);
});

test('Content Understanding setup runs only when enabled, after local IDs, with scoped outputs and operator identity', () => {
  const result = pwsh(`${sourceCommon}
    $script:called = 0
    function node {
      param($ScriptPath)
      $script:called++
      if ($ScriptPath -notlike '*scripts*configure-content-understanding.mjs' -or
          $env:AZURE_CLIENT_ID -or $env:CONTENT_UNDERSTANDING_ENDPOINT -ne 'https://output.cognitiveservices.azure.com' -or
          $env:CONTENT_UNDERSTANDING_ANALYZER_ID -ne 'output-analyzer' -or
          $env:CONTENT_UNDERSTANDING_COMPLETION_MODEL -ne 'output-completion-model' -or
          $env:CONTENT_UNDERSTANDING_COMPLETION_DEPLOYMENT -ne 'output-completion' -or
          $env:CONTENT_UNDERSTANDING_EMBEDDING_MODEL -ne 'output-embedding-model' -or
          $env:CONTENT_UNDERSTANDING_EMBEDDING_DEPLOYMENT -ne 'output-embedding' -or
          $env:AZURE_TENANT_ID -ne '11111111-1111-1111-1111-111111111111') { throw 'Setup credential or output scope drift' }
      $global:LASTEXITCODE = 0
    }
    $settings = Get-DeploymentSettings
    Initialize-ContentUnderstanding -Root (Get-Location).Path -Settings $settings -Outputs ([ordered]@{})
    if ($script:called -ne 0) { throw 'Disabled setup invoked Node' }
    $settings.deployContentUnderstanding = $true
    $outputs = [ordered]@{
      CONTENT_UNDERSTANDING_ENDPOINT = 'https://output.cognitiveservices.azure.com'; CONTENT_UNDERSTANDING_ANALYZER_ID = 'output-analyzer'
      CONTENT_UNDERSTANDING_COMPLETION_MODEL = 'output-completion-model'; CONTENT_UNDERSTANDING_COMPLETION_DEPLOYMENT = 'output-completion'
      CONTENT_UNDERSTANDING_EMBEDDING_MODEL = 'output-embedding-model'; CONTENT_UNDERSTANDING_EMBEDDING_DEPLOYMENT = 'output-embedding'
    }
    Initialize-ContentUnderstanding -Root (Get-Location).Path -Settings $settings -Outputs $outputs
    if ($script:called -ne 1 -or $env:AZURE_CLIENT_ID -ne 'inherited-app-client' -or
        $env:CONTENT_UNDERSTANDING_ENDPOINT -ne 'https://inherited.example.invalid') { throw 'Setup environment was not restored' }
    function node { $global:LASTEXITCODE = 19 }
    try { Initialize-ContentUnderstanding -Root (Get-Location).Path -Settings $settings -Outputs $outputs; exit 7 }
    catch { if ($_.Exception.Message -notlike '*setup failed with code 19*') { throw } }
    if ($env:AZURE_CLIENT_ID -ne 'inherited-app-client' -or
        $env:CONTENT_UNDERSTANDING_ENDPOINT -ne 'https://inherited.example.invalid') { throw 'Failed setup environment was not restored' }
    exit 0
  `, { ...validEnvironment, AZURE_CLIENT_ID: 'inherited-app-client', CONTENT_UNDERSTANDING_ENDPOINT: 'https://inherited.example.invalid' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(read('infra/hooks/postprovision.ps1'), /Write-DemoIds[\s\S]+Initialize-ContentUnderstanding/);
  assert.match(read('scripts/deploy.ps1'), /Write-DemoIds[\s\S]+Initialize-ContentUnderstanding[\s\S]+Invoke-RestMethod/);
});

test('ambient tenant/subscription mismatch stops rather than authenticating or switching accounts', () => {
  const result = pwsh(`${sourceCommon}
    function Invoke-AzJson { return @{ tenantId = $env:AZURE_TENANT_ID; id = 'different' } }
    try { $null = Assert-AzureContext $env:AZURE_TENANT_ID $env:AZURE_SUBSCRIPTION_ID; exit 7 }
    catch { if ($_.Exception.Message -notlike '*does not match*') { throw }; exit 0 }
  `, validEnvironment);
  assert.equal(result.status, 0, result.stderr);
  for (const path of ['infra/hooks/common.ps1', 'infra/hooks/preprovision.ps1', 'scripts/deploy.ps1', '.azuredevops/pipelines/validate.yml']) {
    assert.doesNotMatch(read(path), /\baz(?:d)?\s+(?:auth\s+)?login\b/i, `${path} must not initiate login`);
  }
});

test('soft-deleted optional service names stop without an automatic purge', () => {
  const result = pwsh(`${sourceCommon}
    function Invoke-AzJson {
      param($Arguments)
      if ($Arguments -notcontains 'list-deleted') { throw 'Unexpected resource operation' }
      return @(@{ name = 'cu-guardtest-example' })
    }
    try { Assert-NoSoftDeletedResources (Get-DeploymentSettings) $env:AZURE_SUBSCRIPTION_ID; exit 7 }
    catch { if ($_.Exception.Message -notlike '*Nothing was purged*') { throw }; exit 0 }
  `, { ...validEnvironment, ...contentEnvironment });
  assert.equal(result.status, 0, result.stderr);
});

test('postprovision preserves customized domain and unknown keys while consuming outputs', () => {
  const result = pwsh(`${sourceCommon}
    $folder = Join-Path (Get-Location) "tests/.infra-guard-$PID"
    $null = New-Item -ItemType Directory -Path $folder -Force
    try {
      @{ domain = @{ title = 'Alternate domain'; kpis = @(@{ id = 'different' }) }; custom = 'keep' } |
        ConvertTo-Json -Depth 20 | Set-Content (Join-Path $folder 'demo-ids.local.json')
      $outputs = [ordered]@{
        AZURE_RESOURCE_GROUP = 'example-group'; SERVICE_APP_ENDPOINT_URL = 'https://example.invalid'
        COSMOS_ENDPOINT = 'https://example.documents.azure.com'; COSMOS_DATABASE = 'workbench'; COSMOS_CONTAINER = 'state'
        AZURE_CLIENT_ID = 'example-client'; AZURE_OPENAI_ENDPOINT = ''; AZURE_OPENAI_DEPLOYMENT = ''
        CONTENT_UNDERSTANDING_ENDPOINT = 'https://example.cognitiveservices.azure.com'
        CONTENT_UNDERSTANDING_ANALYZER_ID = 'document_metrics'
        CONTENT_UNDERSTANDING_COMPLETION_MODEL = 'operator-completion-model'
        CONTENT_UNDERSTANDING_COMPLETION_DEPLOYMENT = 'operator-completion'
        CONTENT_UNDERSTANDING_EMBEDDING_MODEL = 'operator-embedding-model'
        CONTENT_UNDERSTANDING_EMBEDDING_DEPLOYMENT = 'operator-embedding'
      }
      Write-DemoIds -Root $folder -Outputs $outputs
      $ids = Get-Content (Join-Path $folder 'demo-ids.local.json') -Raw | ConvertFrom-Json
      if ($ids.domain.title -ne 'Alternate domain' -or $ids.domain.kpis[0].id -ne 'different' -or $ids.custom -ne 'keep') { throw 'Lost existing configuration' }
      if ($ids.cosmosContainer -ne 'state' -or $ids.azureOutputs.AZURE_CLIENT_ID -ne 'example-client') { throw 'Missing output mapping' }
      if ($ids.contentUnderstandingEndpoint -ne $outputs.CONTENT_UNDERSTANDING_ENDPOINT -or
          $ids.contentUnderstandingAnalyzerId -ne 'document_metrics' -or
          $ids.contentUnderstandingCompletionModel -ne 'operator-completion-model' -or
          $ids.contentUnderstandingCompletionDeployment -ne 'operator-completion' -or
          $ids.contentUnderstandingEmbeddingModel -ne 'operator-embedding-model' -or
          $ids.contentUnderstandingEmbeddingDeployment -ne 'operator-embedding') { throw 'Missing Content Understanding output mapping' }
      if ($ids.entraAudience -ne $env:ENTRA_AUDIENCE -or $ids.entraClientId -ne $env:ENTRA_CLIENT_ID -or
          $ids.entraApiScope -ne $env:ENTRA_API_SCOPE) { throw 'Missing public browser authentication configuration' }
    } finally {
      for ($attempt = 0; $attempt -lt 10; $attempt++) {
        try { Remove-Item -Recurse -Force -LiteralPath $folder; break }
        catch { if ($attempt -eq 9) { throw }; Start-Sleep -Milliseconds 100 }
      }
    }
  `, validEnvironment);
  assert.equal(result.status, 0, result.stderr);
});

test('imperative deployment preserves model choices and returns the same output interface', () => {
  const expectedOutputs = [...wrapper.matchAll(/^output (\w+) /gm)].map((match) => match[1]);
  const result = pwsh(`${sourceCommon}
    . ${psQuote(resolve(root, 'infra/deploy-manual.ps1'))}
    $script:requests = @()
    $script:commands = @()
    function Set-ArmResource {
      param($Id, $Version, $Body, $Root)
      $script:requests += @{ id = $Id; version = $Version; body = $Body }
      return @{ id = $Id; properties = @{
        principalId = 'example-principal'; clientId = 'example-client'; loginServer = 'example.azurecr.io'
        customerId = 'example-workspace'; ConnectionString = 'example-connection'; documentEndpoint = 'https://example.documents.azure.com'
        endpoint = 'https://example.cognitiveservices.azure.com'; configuration = @{ ingress = @{ fqdn = 'example.invalid' } }
      } }
    }
    function Invoke-ArmRequest { return @{ primarySharedKey = 'example-not-a-real-key' } }
    function Invoke-AzJson {
      param($Arguments)
      if ($Arguments -notcontains '--subscription') { throw 'Unscoped resource command' }
      $script:commands += ,$Arguments
      return @{}
    }
    $settings = Get-DeploymentSettings
    Assert-DeploymentConfiguration $settings
    $outputs = Invoke-ManualDeployment $settings $env:AZURE_SUBSCRIPTION_ID (Get-Location).Path
    foreach ($name in @(${expectedOutputs.map(psQuote).join(',')})) {
      if (-not $outputs.Contains($name)) { throw "Missing imperative output $name" }
    }
    $model = @($script:requests | Where-Object { $_.id -match '/deployments/operator-deployment$' })[0].body
    if ($model.properties.model.name -ne 'operator-model' -or $model.properties.model.version -ne 'operator-version' -or
        $model.sku.name -ne 'operator-sku' -or $model.properties.versionUpgradeOption -ne 'NoAutoUpgrade') { throw 'Model choice drift' }
    $content = @($script:requests | Where-Object { $_.body.ContainsKey('kind') -and $_.body.kind -eq 'AIServices' })[0]
    if ($content.id -notmatch '/accounts/cu-' -or $content.body.location -ne 'operator-content-region' -or
        $content.body.sku.name -ne 'S0' -or -not $content.body.properties.disableLocalAuth -or
        $content.body.properties.customSubDomainName -notlike 'cu-*') { throw 'Content account configuration drift' }
    foreach ($kind in @('Completion', 'Embedding')) {
      $expectedName = $settings["contentUnderstanding\${kind}DeploymentName"]
      $deployment = @($script:requests | Where-Object { $_.id -eq "$($content.id)/deployments/$expectedName" })[0].body
      if ($deployment.properties.model.format -ne 'OpenAI' -or
          $deployment.properties.model.name -ne $settings["contentUnderstanding\${kind}ModelName"] -or
          $deployment.properties.model.version -ne $settings["contentUnderstanding\${kind}ModelVersion"] -or
          $deployment.sku.name -ne $settings["contentUnderstanding\${kind}DeploymentSku"] -or
          $deployment.sku.capacity -ne $settings["contentUnderstanding\${kind}Capacity"] -or
          $deployment.properties.versionUpgradeOption -ne 'NoAutoUpgrade') { throw "CU $kind model choice drift" }
    }
    $contentRoles = @($script:commands | Where-Object { $_ -contains $content.id -and $_ -contains 'a97b65f3-24c7-4388-baec-2e87135dc908' })
    if ($contentRoles.Count -ne 2) { throw 'Missing runtime/setup Content Understanding role assignment' }
    if (@($contentRoles | Where-Object { $_ -contains $env:AZURE_PRINCIPAL_ID -and $_ -contains 'User' }).Count -ne 1 -or
        @($contentRoles | Where-Object { $_ -contains 'example-principal' -and $_ -contains 'ServicePrincipal' }).Count -ne 1) { throw 'Content role principal drift' }
    $app = @($script:requests | Where-Object { $_.id -match '/containerApps/' })[0].body
    $auth = @($app.properties.template.containers[0].env | Where-Object name -eq 'AUTH_MODE')[0].value
    if ($auth -ne 'entra' -or $app.properties.template.scale.maxReplicas -ne 1) { throw 'Application safety setting drift' }
    foreach ($name in @('CONTENT_UNDERSTANDING_ENDPOINT', 'CONTENT_UNDERSTANDING_ANALYZER_ID',
        'CONTENT_UNDERSTANDING_COMPLETION_MODEL', 'CONTENT_UNDERSTANDING_COMPLETION_DEPLOYMENT',
        'CONTENT_UNDERSTANDING_EMBEDDING_MODEL', 'CONTENT_UNDERSTANDING_EMBEDDING_DEPLOYMENT')) {
      $actual = @($app.properties.template.containers[0].env | Where-Object name -eq $name)[0].value
      if ($actual -cne $outputs[$name] -or -not $actual) { throw "Content runtime/output mismatch: $name" }
    }
    foreach ($name in @('ENTRA_AUDIENCE', 'ENTRA_CLIENT_ID', 'ENTRA_API_SCOPE')) {
      $actual = @($app.properties.template.containers[0].env | Where-Object name -eq $name)[0].value
      if ($actual -cne [Environment]::GetEnvironmentVariable($name)) { throw "Browser authentication setting drift: $name" }
    }
  `, { ...validEnvironment, ...contentEnvironment, DEPLOY_OPENAI: 'true',
    AZURE_OPENAI_MODEL_NAME: 'operator-model', AZURE_OPENAI_MODEL_VERSION: 'operator-version',
    AZURE_OPENAI_DEPLOYMENT: 'operator-deployment', AZURE_OPENAI_DEPLOYMENT_SKU: 'operator-sku' });
  assert.equal(result.status, 0, result.stderr);
});

test('all deployment hooks and entry points parse as PowerShell', () => {
  const scripts = ['infra/hooks/common.ps1', 'infra/hooks/preprovision.ps1', 'infra/hooks/postprovision.ps1',
    'infra/deploy-manual.ps1', 'scripts/deploy.ps1', 'scripts/start-local.ps1'];
  const result = pwsh(`
    foreach ($path in @(${scripts.map((path) => psQuote(resolve(root, path))).join(',')})) {
      $tokens = $null; $errors = $null
      $null = [Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
      if ($errors.Count) { throw ($errors | Out-String) }
    }
  `);
  assert.equal(result.status, 0, result.stderr);
});

test('local starter selects loopback JSON state without authenticating inherited cloud settings', () => {
  const result = pwsh(`
    function az { throw 'Local rehearsal attempted cloud authentication' }
    function node {
      if ($env:AUTH_MODE -ne 'local' -or $env:HOST -ne '127.0.0.1' -or $env:STATE_PROVIDER -ne 'local' -or $env:COSMOS_ENDPOINT) {
        throw 'Local starter retained a cloud state/authentication setting'
      }
      $global:LASTEXITCODE = 0
    }
    & ${psQuote(resolve(root, 'scripts/start-local.ps1'))}
  `, { COSMOS_ENDPOINT: 'https://inherited.example.invalid', AUTH_MODE: 'entra' });
  assert.equal(result.status, 0, result.stderr);
});

test('Azure local extraction requires Content Understanding settings and preserves explicit provider selection', () => {
  const missing = pwsh(`
    function az { throw 'UNEXPECTED_AZURE_CALL' }
    try { & ${psQuote(resolve(root, 'scripts/start-local.ps1'))} -ExtractionProvider azure; exit 7 }
    catch { if ($_.Exception.Message -notlike '*CONTENT_UNDERSTANDING_ENDPOINT is required*') { throw } }
    exit 0
  `, { CONTENT_UNDERSTANDING_ENDPOINT: '' });
  assert.equal(missing.status, 0, missing.stderr);
  const configured = pwsh(`
    function az { '{"tenantId":"11111111-1111-1111-1111-111111111111","id":"22222222-2222-2222-2222-222222222222"}'; $global:LASTEXITCODE = 0 }
    function node {
      if ($env:EXTRACTION_PROVIDER -ne 'azure' -or $env:ANSWER_PROVIDER -ne 'local' -or
          $env:AUTH_MODE -ne 'local' -or $env:STATE_PROVIDER -ne 'local' -or
          $env:CONTENT_UNDERSTANDING_COMPLETION_MODEL -ne 'operator-completion-model') { throw 'Local Azure extraction setting drift' }
      $global:LASTEXITCODE = 0
    }
    & ${psQuote(resolve(root, 'scripts/start-local.ps1'))} -ExtractionProvider azure
  `, { ...validEnvironment, ...contentEnvironment, CONTENT_UNDERSTANDING_ENDPOINT: 'https://example.cognitiveservices.azure.com' });
  assert.equal(configured.status, 0, configured.stderr);
});

test('every infrastructure setting/output and hook environment variable is documented', () => {
  const docs = readdirSync(resolve(root, 'docs')).filter((name) => name.endsWith('.md'))
    .map((name) => read(join('docs', name))).join('\n');
  const names = new Set();
  for (const { value } of Object.values(parameters)) names.add(value.match(/^\$\{([^=}]+)/)[1]);
  for (const [, name] of wrapper.matchAll(/^output (\w+) /gm)) names.add(name);
  for (const [, name] of main.matchAll(/name: '([A-Z][A-Z0-9_]+)'/g)) names.add(name);
  for (const [, name] of read('infra/hooks/common.ps1').matchAll(/Get-(?:Boolean)?Setting '([A-Z][A-Z0-9_]+)'/g)) names.add(name);
  for (const path of ['scripts/deploy.ps1', 'scripts/start-local.ps1']) {
    for (const [, name] of read(path).matchAll(/\$env:([A-Z][A-Z0-9_]+)/g)) names.add(name);
  }
  for (const name of names) assert.ok(docs.includes(name), `undocumented setting/output: ${name}`);
});
