[README](../README.md) › [Reproduce](./00-reproduce-this-demo.md) › Deployment

# 03 — Deployment

<p>
<img src="./assets/icons/powershell.svg" width="40" alt="PowerShell"/>&nbsp;
<img src="./assets/icons/container-apps.svg" width="40" alt="Azure Container Apps"/>&nbsp;
<img src="./assets/icons/container-registry.svg" width="40" alt="Container Registry"/>&nbsp;
<img src="./assets/icons/managed-identity.svg" width="40" alt="Managed identity"/>
</p>

![azd up](./assets/badges/azd-up.svg) ![Cloud static only](./assets/badges/static-only.svg) ![Opt-in](./assets/badges/opt-in.svg)

This is the operator runbook for deploying the workbench to an explicitly approved Azure tenant and subscription. The Azure Developer CLI wrapper and PowerShell entry point use the same Bicep resources. If policy prohibits templates, use the [manual Portal and imperative alternative](./03b-manual-deployment.md). No Azure resources were provisioned or authenticated while authoring this reference.

## Fast path — azd up

> [!WARNING]
> **Phase 0 — Authenticate to the right tenant.** Azure CLI and Azure Developer CLI maintain separate logins. Supply real approved target values below, verify both contexts, and never rely on the last account used elsewhere.

<details><summary><b>Tenant-explicit fast path — run only after prerequisites are met</b></summary>

```powershell
$TenantId = '<approved-tenant-id>'
$SubscriptionId = '<approved-subscription-id>'
$Location = '<approved-region>'
$Audience = '<existing-api-application-client-id-guid>'
$SpaClientId = '<existing-public-spa-client-id-guid>'
$ApiScope = 'api://<existing-api-application-client-id-guid>/access_as_user'
$EnvironmentName = 'workbench01'

az login --tenant $TenantId
az account set --subscription $SubscriptionId
az account show --query '{tenant:tenantId,subscription:id,user:user.name}' -o table
# Stop if either tenant or subscription does not match the reviewed target.
azd auth login --tenant-id $TenantId
azd env new $EnvironmentName
azd env set AZURE_TENANT_ID $TenantId
azd env set AZURE_SUBSCRIPTION_ID $SubscriptionId
azd env set AZURE_LOCATION $Location
azd env set ENTRA_AUDIENCE $Audience
azd env set ENTRA_CLIENT_ID $SpaClientId
azd env set ENTRA_API_SCOPE $ApiScope
azd env set DEPLOY_CONTENT_UNDERSTANDING false
azd env set DEPLOY_OPENAI false
azd env get-values
azd provision --preview
# Review the resource plan and role assignments before the write:
azd up
```

Environment names are 3–16 lowercase letters/digits, beginning with a letter. Choose a fresh environment for a fresh deployment. A denied target, missing audience/client/scope or mismatched context is a stop condition—not a reason to bypass the hook.

</details>

[![azd deployment flow](./assets/azd-deployment-flow.png)](./assets/azd-deployment-flow.png)

<sub>Editable source: [deployment flow](./assets/azd-deployment-flow.drawio).</sub>

## At a glance

| | Item | Behavior |
|---|---|---|
| <img src="./assets/icons/resource-group.svg" width="24" alt="Resources"/> | Shared templates | `infra/azd.bicep` is subscription-scoped and calls `infra/main.bicep` in the resource group. |
| <img src="./assets/icons/container-registry.svg" width="24" alt="Registry"/> | Build | Remote registry build creates the application image; local Docker is not required for this path. |
| <img src="./assets/icons/entra-id.svg" width="24" alt="Identity"/> | Authentication | Cloud runtime is Entra mode; local role selection is disabled. |
| <img src="./assets/icons/cosmos-db.svg" width="24" alt="Cosmos DB"/> | Persistence | Managed identity accesses the provisioned NoSQL database/container. |

The project definition follows the public [azure.yaml schema](https://learn.microsoft.com/en-us/azure/developer/azure-developer-cli/azd-schema). The subscription wrapper forwards each main-template parameter; it is not a second resource implementation.

## Phase 1 — Prepare configuration and application identity

| Step | | Action | Gate |
|---|---|---|---|
| **1.1** | <img src="./assets/icons/app-registrations.svg" width="24" alt="Registration"/> | Configure the API and separate public SPA registrations below | The browser can obtain a v2 access token carrying the expected scope and API app role. |
| **1.2** | <img src="./assets/icons/file.svg" width="24" alt="Configuration"/> | Review the template's `domain` block before image build | Only synthetic example content is packaged. |
| **1.3** | <img src="./assets/icons/gear.svg" width="24" alt="Settings"/> | Review [all settings](./08-configuration-reference.md) | Location, database and optional AI parameters are intentional. |
| **1.4** | <img src="./assets/icons/code.svg" width="24" alt="Tests"/> | Run `npm ci`, `npm test`, `npm run evaluate` | Baseline local tests pass before spending on Azure. |

For local customization, `demo-ids.local.json` overrides the template. The ignored local file is not sent in the container build. To customize the hosted domain, apply the reviewed generic `domain` configuration to the build template before building; do not add real IDs, credentials or organizational source content to it.

### Portal identity setup — required outside Bicep

| Step | Entra admin center action | Exact configuration / proof |
|---|---|---|
| API registration | App registrations → create/select a single-tenant API app | Use its **Application (client) ID GUID** as `ENTRA_AUDIENCE`, not its object ID, SPA client ID or scope URI. Set manifest `api.requestedAccessTokenVersion` to `2`. |
| Delegated scope | API app → Expose an API → set Application ID URI and add a scope | For example, scope name `access_as_user` gives `api://<API-app-id>/access_as_user`; configure the full chosen value as `ENTRA_API_SCOPE`. Do not request Microsoft Graph for this API. |
| API roles | API app → App roles → create enabled Users/Groups roles | Exact values `reviewer`, `manager`, `auditor`; assign the intended users/groups under the **API enterprise application**. A directory job title or scope consent does not grant a role. |
| Public SPA client | Create/select a separate single-tenant client app → Authentication → Add a platform → Single-page application | No client secret. Its Application (client) ID becomes `ENTRA_CLIENT_ID`. Do not enable implicit-grant tokens for this code flow. |
| Client permissions | SPA app → API permissions → My APIs → this API → Delegated permissions | Add the exposed scope and grant the consent required by your tenant's policy. Configure owners if the API is absent from My APIs. |
| Callback after app provisioning | SPA app → Authentication → SPA redirect URIs | Add **exactly** `https://<deployed-app-host>/auth/callback`, using `appUrl` from the generated local outputs. Preserve scheme, host, port if any and path. |
| Browser proof | Open hosted root → Sign in with Microsoft | Redirect to tenant-specific authorize endpoint and back to callback; `/api/session` succeeds only with the intended scope and role. |

This follows the official [authorization-code/PKCE flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow), [API scope configuration](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-configure-app-expose-web-apis) and [app-role guidance](https://learn.microsoft.com/en-us/entra/identity-platform/howto-add-app-roles-in-apps). The redirect **platform type must be SPA** so the browser token exchange has the expected CORS behavior. Application registration and consent are operator steps; resource provisioning alone cannot complete them.

[![Browser PKCE and API authorization flow](./assets/browser-authentication-flow.png)](./assets/browser-authentication-flow.png)

<sub>Editable source: [browser authentication flow](./assets/browser-authentication-flow.drawio).</sub>

The public `GET /api/auth/config` returns only `authMode`, `tenantId`, `clientId`, `scope` and `redirectPath`; it exposes no credential or source data. The browser uses a one-use PKCE transaction, keeps the access token in memory and attaches `Authorization: Bearer` to API requests, including source retrieval. Reloading requires sign-in again; this POC is not a persistent token cache. Platform login routes, a Blob token store and a confidential-client secret are not part of this deployment.

The transaction in `sessionStorage` contains only state, verifier, creation time, redirect URI and public tenant/client/scope settings. It expires after ten minutes and is removed before callback validation/redemption; callback code/state query parameters are scrubbed from browser history. The client requests only the API scope, not an ID token, `offline_access` or a refresh token. Unsolicited ID tokens are ignored. Access tokens use a 30-second expiry margin, with no silent refresh; sign in again after reload/expiry. Explicit sign-out clears local auth state and redirects to the configured tenant's logout endpoint. Source links retain their ordinary API URL, but authenticated clicks fetch with the bearer header and download a Blob; tokens never enter URLs or browser storage. The temporary download link is removed immediately and its object URL is revoked after 60 seconds.

The deployment guard currently supports the default API identifier form `api://<ENTRA_AUDIENCE>/<scope-name>` only. A custom verified-domain Application ID URI needs an explicit implementation change and tests; do not bypass the guard by substituting a Graph scope. Microsoft recommends a supported authentication library instead of manually crafted protocol requests; this native helper is deliberately a small POC boundary, with production library adoption and tenant validation still required.

- [ ] Audience identifies this API's GUID, not Microsoft Graph or the SPA app.
- [ ] Client ID, full delegated scope, exact SPA callback and required consent are configured.
- [ ] Role assignments are intentional; an auditor remains read-only.
- [ ] Local-only auth is not selected in the hosted settings.

## Phase 2 — Preview and provision the foundation

| Step | | Action | Proof |
|---|---|---|---|
| **2.1** | <img src="./assets/icons/powershell.svg" width="24" alt="Guard"/> | Run preprovision validation through `azd provision --preview` | ![Static only](./assets/badges/static-only.svg) Names, target, required settings and model prerequisites pass when run. |
| **2.2** | <img src="./assets/icons/resource-group.svg" width="24" alt="Resource group"/> | Inspect the resource group plan | No unrelated resource is unexpectedly changed. |
| **2.3** | <img src="./assets/icons/managed-identity.svg" width="24" alt="Identity"/> | Inspect roles and optional services | Registry/Cosmos roles; AI roles only when enabled. |
| **2.4** | <img src="./assets/icons/container-apps.svg" width="24" alt="Deploy"/> | Run `azd up` | Provision, package/deploy and hooks complete. |

| Hook / entry point | Responsibility | Failure means |
|---|---|---|
| `infra/hooks/preprovision.ps1` | Load validated settings and compare Azure CLI tenant/subscription | Stop; correct the explicit target. |
| `infra/hooks/postprovision.ps1` | Persist outputs to ignored local reference file | Stop if required outputs or domain preservation fail. |
| `infra/hooks/common.ps1` | Shared validation, context checks and safe local-ID write | Do not duplicate these rules in another deployment script. |
| `azure.yaml` application service | Build/deploy the Node application image | A provisioned bootstrap container is not the workbench. |

The initial template image is a public bootstrap application. It must be replaced with this repository's image. Only the workbench's `/health` JSON plus authorized API checks count as application validation.

- [ ] Resource names and outputs match the selected environment.
- [ ] Local reference IDs are ignored by Git.
- [ ] Optional AI resources were not created inadvertently.

## Phase 3 — Validate deployed identity and state

<details><summary><b>Read outputs and inspect the deployed application</b></summary>

```powershell
$values = Get-Content demo-ids.local.json -Raw | ConvertFrom-Json
$AppUrl = $values.appUrl
Invoke-RestMethod "$AppUrl/health"
# The hosted UI obtains a token through its configured PKCE sign-in.
# These optional API probes use a token obtained through an approved test client.
# Keep it only in this process; never place it in a transcript or screenshot.
$headers = @{ Authorization = "Bearer $env:WORKBENCH_ACCESS_TOKEN" }
Invoke-RestMethod "$AppUrl/api/session" -Headers $headers
Invoke-RestMethod "$AppUrl/api/state" -Headers $headers
az containerapp show --subscription $SubscriptionId --resource-group $values.resourceGroup `
  --name $values.azureOutputs.AZURE_CONTAINER_APP_NAME --query properties.configuration -o json
```

`WORKBENCH_ACCESS_TOKEN` is a short-lived secret in this operator example, not a stored application setting. Remove it when finished.

</details>

| Check | Expected outcome |
|---|---|
| Missing token | Unauthorized API response, not a local role cookie. |
| Wrong audience/tenant/issuer/expired token | Rejected by the API. |
| Reviewer tries manager approval | Forbidden. |
| Auditor attempts mutation | Forbidden. |
| Source ID without authorized access | No source bytes returned. |
| Revision restart after a synthetic change | Same state read from Cosmos. |
| Stale expected version / ETag | Conflict rather than last-write-wins data loss. |

Managed identity image-pull configuration follows [Container Apps guidance](https://learn.microsoft.com/en-us/azure/container-apps/managed-identity-image-pull). Cosmos data access follows [NoSQL RBAC guidance](https://learn.microsoft.com/en-us/azure/cosmos-db/nosql/how-to-connect-role-based-access-control). RBAC propagation can take time; verify assignments before retrying instead of enabling account keys.

- [ ] `/health` identifies the actual application.
- [ ] Positive and negative role tests pass.
- [ ] Persistence survives restart.
- [ ] No bearer tokens or document contents appear in logs.

## Phase 4 — Enable extraction and answers independently

| Capability | Required settings | Additional proof |
|---|---|---|
| Content Understanding custom schema | `DEPLOY_CONTENT_UNDERSTANDING=true`; approved region; explicit completion/embedding model deployments and analyzer ID | Authorized whole document yields validated fields, confidence and source grounding; missing numeric grounding abstains. |
| Responses | `DEPLOY_OPENAI=true`; explicit model/name/version/deployment/SKU/capacity | Model supports Responses structured output; unsupported claims abstain. |
| Both | Both sets plus reviewed regions and budget | One provider failure cannot silently switch the other to a simulated path. |

> [!IMPORTANT]
> No model is selected for you. Verify current model availability, retirement, deployment SKU and structured-output support for your subscription. A resource account without a compatible model deployment is not a working answer provider.

<details><summary><b>Optional-provider settings recipe</b></summary>

```powershell
azd env set DEPLOY_CONTENT_UNDERSTANDING true
azd env set CONTENT_UNDERSTANDING_LOCATION '<approved-extraction-region>'
azd env set CONTENT_UNDERSTANDING_ANALYZER_ID 'document_metrics'
# azd normally supplies its current operator principal. Manual/script paths must set it explicitly.
azd env set AZURE_PRINCIPAL_ID '<setup-principal-guid>'
azd env set AZURE_PRINCIPAL_TYPE 'User'
azd env set CONTENT_UNDERSTANDING_COMPLETION_MODEL '<supported-completion-model-name>'
azd env set CONTENT_UNDERSTANDING_COMPLETION_MODEL_VERSION '<verified-current-version>'
azd env set CONTENT_UNDERSTANDING_COMPLETION_DEPLOYMENT '<chosen-completion-deployment>'
azd env set CONTENT_UNDERSTANDING_COMPLETION_DEPLOYMENT_SKU '<verified-deployment-sku>'
azd env set CONTENT_UNDERSTANDING_COMPLETION_CAPACITY '1'
azd env set CONTENT_UNDERSTANDING_EMBEDDING_MODEL '<supported-embedding-model-name>'
azd env set CONTENT_UNDERSTANDING_EMBEDDING_MODEL_VERSION '<verified-current-version>'
azd env set CONTENT_UNDERSTANDING_EMBEDDING_DEPLOYMENT '<chosen-embedding-deployment>'
azd env set CONTENT_UNDERSTANDING_EMBEDDING_DEPLOYMENT_SKU '<verified-deployment-sku>'
azd env set CONTENT_UNDERSTANDING_EMBEDDING_CAPACITY '1'
azd env set DEPLOY_OPENAI true
azd env set AZURE_OPENAI_LOCATION '<approved-model-region>'
azd env set AZURE_OPENAI_MODEL_NAME '<verified-model-name>'
azd env set AZURE_OPENAI_MODEL_VERSION '<verified-model-version>'
azd env set AZURE_OPENAI_DEPLOYMENT '<chosen-deployment-name>'
azd env set AZURE_OPENAI_DEPLOYMENT_SKU '<verified-deployment-sku>'
azd env set AZURE_OPENAI_CAPACITY '1'
azd provision --preview
azd up
```

These are placeholders, not recommended model pins. Each capacity's units depend on its chosen deployment; inspect current quota and pricing before accepting this example. For direct `deploy.ps1` use, supply the same names as process environment settings, including the setup principal. Setup/model defaults are required even when answer generation stays local; you can leave `DEPLOY_OPENAI=false` to evaluate extraction independently.

</details>

The extraction adapter uses a [custom Content Understanding analyzer](https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/concepts/analyzer-reference) with stable GA API `2025-11-01`; it is not a layout-only call. Fields use `method: extract`, with confidence/source grounding enabled. The answer adapter independently uses the [Responses API](https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/responses) with schema under [text.format](https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/structured-outputs).

### Custom-analyzer setup and lifecycle

| Setup step | Responsible component | Stop condition |
|---|---|---|
| Provision dedicated extraction resource | Shared Bicep or manual runner: AIServices S0, managed identity bindings, explicit completion and embedding deployments | Missing model/version/SKU, unsupported region or insufficient role-assignment permission. |
| Initialize model defaults | `scripts/configure-content-understanding.mjs`, invoked by deployment hooks/shared runner | Existing model-name mapping differs: do not overwrite it. Missing entries alone are merged using `application/merge-patch+json`. |
| Create domain-derived analyzer | Same setup script; data-plane analyzer API, not an ARM analyzer resource | Existing analyzer schema differs: do not replace it automatically. |
| Invoke extraction | Runtime submits bytes to the configured analyzer with explicit model-name → deployment-name mappings | Invalid fields, absent numeric source spans, failed analysis or unsafe poll location. |

Use a **new** `CONTENT_UNDERSTANDING_ANALYZER_ID` when changing the extraction schema/domain or model configuration, or perform a separately reviewed external migration. The setup path never silently replaces an existing analyzer or conflicting resource default. The operator setup principal needs Cognitive Services User as well as the runtime identity; allow for role propagation before retrying setup.

The [model setup quickstart](https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/quickstart/use-rest-api) and [custom analyzer documentation](https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/tutorial/create-custom-analyzer) describe these distinct data-plane prerequisites. No default model/version/SKU is invented. Preview agentic analysis is not enabled.

<details><summary><b>Repeat data-plane setup after provisioning, without replacing an analyzer</b></summary>

After explicit tenant/subscription authentication and resource/model provisioning, the standalone command below loads `demo-ids.local.json` (otherwise the template). The six runtime Content Understanding environment values override corresponding file values. Keep `AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID` in the process environment so the local credential gate verifies the actual account context.

```powershell
node scripts/configure-content-understanding.mjs
```

The CLI retries **only HTTP 403** for role propagation, bounded to 180 seconds; schema/default conflicts and other errors do not become an infinite retry. It reads back model defaults and the analyzer after setup. Deployment hooks/shared scripts run this automatically; the command is useful for a Portal-only resource path or a deliberate retry after fixing permissions. No service call was made to author these instructions.

</details>

Before any cloud upload, separately authorize the whole document for model processing. Detectable known restricted content is rejected before the call; a restriction discovered only in the result has already reached extraction models. No arbitrary scanned/mixed-document redaction is claimed. Native XLSX, CSV and JSON continue to use local direct parsers when cloud extraction is configured.

## Alternate entry point and cleanup

<details><summary><b>Shared-Bicep PowerShell deployment</b></summary>

```powershell
$env:ENTRA_CLIENT_ID = $SpaClientId
$env:ENTRA_API_SCOPE = $ApiScope
.\scripts\deploy.ps1 -TenantId $TenantId -SubscriptionId $SubscriptionId `
  -EnvironmentName $EnvironmentName -Location $Location -EntraAudience $Audience
```

The script validates context, deploys `infra/azd.bicep`, remotely builds the image, updates the application and verifies health. It does not authenticate on your behalf.

</details>

| Operation | Safety gate | Recommendation |
|---|---|---|
| Re-deploy application | Confirm intended environment and image | Rerun tests after configuration changes. |
| Reset local state | Local synthetic manager only | Do not treat it as a cloud reset mechanism. |
| `azd down --purge` | Confirm target, resource list and retention approval first | Disposable resources only; destructive and potentially irreversible. |
| Keep environment | Budget and cleanup owner remain assigned | Review database and log retention costs. |

Next: [Manual deployment equivalent](./03b-manual-deployment.md).

*Last updated: 2026-11-17*
