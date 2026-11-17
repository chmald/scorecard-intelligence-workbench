[README](../README.md) › [Reproduce](./00-reproduce-this-demo.md) › Deployment

# 03 — Deployment

<p>
<img src="./assets/icons/powershell.svg" width="40" alt="PowerShell"/>&nbsp;
<img src="./assets/icons/container-apps.svg" width="40" alt="Azure Container Apps"/>&nbsp;
<img src="./assets/icons/container-registry.svg" width="40" alt="Container Registry"/>&nbsp;
<img src="./assets/icons/managed-identity.svg" width="40" alt="Managed identity"/>
</p>

![azd up](./assets/badges/azd-up.svg) ![Cloud static only](./assets/badges/static-only.svg) ![Cloud defaults](./assets/badges/default.svg)

This is the operator runbook for deploying the workbench to an explicitly approved Azure tenant and subscription. The Azure Developer CLI wrapper and PowerShell entry point use the same Bicep resources. If policy prohibits templates, use the [manual Portal and imperative alternative](./03b-manual-deployment.md). No Azure resources were provisioned or authenticated while authoring this reference.

## Fast path — azd up

> [!WARNING]
> **Phase 0 — Authenticate to the right tenant.** Azure CLI and Azure Developer CLI maintain separate logins. Supply real approved target values below, verify both contexts, and never rely on the last account used elsewhere.

For a fresh checkout with the [prerequisites](./02-prerequisites.md) satisfied, run:

```powershell
azd up
```

azd asks for an environment name if needed. The preup bootstrap prompts only for missing explicit tenant/subscription/region settings, uses `swedencentral` as the configurable default region, verifies the intended Azure CLI and azd tenants and logs into the correct target when required. It persists validated settings and identity IDs **before** template parameter resolution. There is no separate app-registration, model-deployment or callback command afterward. Confirm the displayed target; never accept an ambient account as evidence of intent.

This ordering is supported by azd's implementation: [command-hook middleware](https://github.com/Azure/azure-dev/blob/main/cli/azd/cmd/middleware/hooks.go) wraps the action with hooks, and [`RunHooks`](https://github.com/Azure/azure-dev/blob/main/cli/azd/pkg/ext/hooks_runner.go) reloads the environment before and after each hook. Consequently, `ENTRA_*` values persisted by preup are available before Bicep parameter substitution; this source inspection is not live-deployment evidence.

The expanded equivalent below is useful when you want to set every target input before the single deployment command:

<details><summary><b>Tenant-explicit fast path — run only after prerequisites are met</b></summary>

```powershell
$TenantId = '<approved-tenant-id>'
$SubscriptionId = '<approved-subscription-id>'
$Location = 'swedencentral' # Default; override only with an approved compatible region.
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
azd env get-values
# One command bootstraps identity, provisions all default resources,
# configures the analyzer/callback, and builds/deploys the application:
azd up
```

Environment names are 3–16 lowercase letters/digits, beginning with a letter. Choose a fresh environment for a fresh deployment. A denied target, missing directory permissions, unavailable model quota or mismatched context is a stop condition—not a reason to bypass a hook.

Both `DEPLOY_CONTENT_UNDERSTANDING` and `DEPLOY_OPENAI` default to `true` for cloud provisioning. The bootstrap creates the single-tenant API and public SPA registrations, API scope/app roles and service principals, grants only the current operator the demo's `manager` role, and persists the resulting public IDs. Previously auto-created managed apps for the same tenant/subscription/environment are reused. Externally managed apps require `AUTO_CONFIGURE_ENTRA=false` and manual callback/role maintenance. Automatic postprovision adds the exact hosted callback only on the owned managed SPA without removing existing URIs, initializes missing model mappings and the domain analyzer, and writes ignored local outputs. Directory permissions, tenant consent policy, Azure role-assignment authority and model availability/quota remain prerequisites.

The local rehearsal command is unchanged: it forces local identity, JSON state and deterministic providers. Deploying resources never authorizes local cloud processing. For a deliberately reduced cloud deployment, explicitly opt out before `azd up`; do not present that reduced environment as the complete default demo.

Existing azd environments retain explicit settings, including an earlier `false`. To migrate an older environment to the complete default footprint, select and verify that environment/target, then run:

```powershell
azd env set DEPLOY_CONTENT_UNDERSTANDING true
azd env set DEPLOY_OPENAI true
azd up
```

In non-interactive automation, `AZD_NON_INTERACTIVE=true` or `CI=true` prevents target/login prompts. Supply the intended tenant/subscription/environment and approved region/authentication in advance; a missing target or login fails rather than falling back to ambient credentials.

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
| **1.1** | <img src="./assets/icons/app-registrations.svg" width="24" alt="Registration"/> | Allow bootstrap to create/reuse same-target managed API/SPA identity, or opt out for an externally managed pair | Only the current operator receives the demo manager role automatically; additional users require deliberate assignment. |
| **1.2** | <img src="./assets/icons/file.svg" width="24" alt="Configuration"/> | Review the template's `domain` block before image build | Only synthetic example content is packaged. |
| **1.3** | <img src="./assets/icons/gear.svg" width="24" alt="Settings"/> | Review [all settings](./08-configuration-reference.md) | Location, database and default-on AI costs/model settings are intentional. |
| **1.4** | <img src="./assets/icons/code.svg" width="24" alt="Tests"/> | Run `npm ci`, `npm test`, `npm run evaluate` | Baseline local tests pass before spending on Azure. |

For local customization, `demo-ids.local.json` overrides the template. The ignored local file is not sent in the container build. To customize the hosted domain, apply the reviewed generic `domain` configuration to the build template before building; do not add real IDs, credentials or organizational source content to it.

### Portal identity setup — reference for reuse and inspection

These are the identity objects/settings the automatic bootstrap configures outside Bicep. They are **not mandatory manual steps** for a fresh `azd up`. Use this table to inspect generated identity, prepare a compatible existing pair, or perform a separately approved Portal-only deployment.

`AUTO_CONFIGURE_ENTRA=true` is the default. Managed apps are identified by deterministic environment names and ownership tags; bootstrap must not adopt an unowned same-name application. To reuse a manually managed pair without directory mutation, set `AUTO_CONFIGURE_ENTRA=false` and supply `ENTRA_AUDIENCE`, `ENTRA_CLIENT_ID` and `ENTRA_API_SCOPE`; ensure the roles, preauthorization/consent and callback already satisfy the table below. That opt-out also leaves callback maintenance with the operator.

| Step | Entra admin center action | Exact configuration / proof |
|---|---|---|
| API registration | App registrations → create/select a single-tenant API app | Use its **Application (client) ID GUID** as `ENTRA_AUDIENCE`, not its object ID, SPA client ID or scope URI. Set manifest `api.requestedAccessTokenVersion` to `2`. |
| Delegated scope | API app → Expose an API → set Application ID URI and add a scope | For example, scope name `access_as_user` gives `api://<API-app-id>/access_as_user`; configure the full chosen value as `ENTRA_API_SCOPE`. Do not request Microsoft Graph for this API. |
| API roles | API app → App roles → create enabled Users/Groups roles | Exact values `reviewer`, `manager`, `auditor`; assign the intended users/groups under the **API enterprise application**. A directory job title or scope consent does not grant a role. |
| Public SPA client | Create/select a separate single-tenant client app → Authentication → Add a platform → Single-page application | No client secret. Its Application (client) ID becomes `ENTRA_CLIENT_ID`. Do not enable implicit-grant tokens for this code flow. |
| Client permissions | SPA app → API permissions → My APIs → this API → Delegated permissions; API → Authorized client applications | Bootstrap configures the exposed API scope and scoped SPA preauthorization, not Microsoft Graph application grants or tenant-wide admin consent. A manually managed pair must meet tenant consent policy. |
| Callback after app provisioning | SPA app → Authentication → SPA redirect URIs | Postprovision merges **exactly** `https://<deployed-app-host>/auth/callback`, using `appUrl`, while preserving existing URIs. Preserve scheme, host, port if any and path. With automation disabled, maintain it explicitly. |
| Browser proof | Open hosted root → Sign in with Microsoft | Redirect to tenant-specific authorize endpoint and back to callback; `/api/session` succeeds only with the intended scope and role. |

This follows the official [authorization-code/PKCE flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow), [API scope configuration](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-configure-app-expose-web-apis) and [app-role guidance](https://learn.microsoft.com/en-us/entra/identity-platform/howto-add-app-roles-in-apps). The redirect **platform type must be SPA** so the browser token exchange has the expected CORS behavior. The bootstrap performs directory operations using the authenticated operator's existing authority; it cannot bypass tenant consent or application-management policy. See also the [azd hook lifecycle](https://learn.microsoft.com/en-us/azure/developer/azure-developer-cli/azd-extensibility).

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
| **2.1** | <img src="./assets/icons/powershell.svg" width="24" alt="Guard"/> | Optionally run `azd provision --preview` on initialized settings | ![Static only](./assets/badges/static-only.svg) Strict configuration/context validation; preview does not create directory apps. A fresh environment uses preup via `azd up`, not preview as an identity bootstrap. |
| **2.2** | <img src="./assets/icons/resource-group.svg" width="24" alt="Resource group"/> | Inspect the resource group plan | No unrelated resource is unexpectedly changed. |
| **2.3** | <img src="./assets/icons/managed-identity.svg" width="24" alt="Identity"/> | Inspect roles and AI services | Registry/Cosmos roles plus default-on extraction/setup and answer roles; explicit opt-outs remove the corresponding services. |
| **2.4** | <img src="./assets/icons/container-apps.svg" width="24" alt="Deploy"/> | Run `azd up` | Provision, package/deploy and hooks complete. |

| Hook / entry point | Responsibility | Failure means |
|---|---|---|
| `infra/hooks/preup.ps1` / `infra/hooks/bootstrap.ps1` | Resolve explicit target; verify/authenticate both CLIs; initialize default settings and identity; persist azd inputs | Stop on denied target/directory operations; never trust ambient tenant/subscription. |
| `infra/hooks/identity.ps1` | `Initialize-WorkbenchIdentity` creates/reuses managed API/SPA identity; `Complete-WorkbenchIdentity` merges exact callback | Missing directory authority or ownership mismatch is not bypassed. |
| `infra/hooks/preprovision.ps1` | Load validated settings and compare Azure CLI tenant/subscription | Stop; correct the explicit target. |
| `infra/hooks/postprovision.ps1` | Persist ignored local outputs; merge exact SPA callback; configure CU defaults/analyzer | Stop on identity mismatch, denied directory access, conflicting analyzer/defaults or domain preservation failure. |
| `infra/hooks/common.ps1` | Shared validation, context checks and safe local-ID write | Do not duplicate these rules in another deployment script. |
| `azure.yaml` application service | Build/deploy the Node application image | A provisioned bootstrap container is not the workbench. |

The initial template image is a public bootstrap application. It must be replaced with this repository's image. Only the workbench's `/health` JSON plus authorized API checks count as application validation.

- [ ] Resource names and outputs match the selected environment.
- [ ] Local reference IDs are ignored by Git.
- [ ] Default-on extraction and Responses resources, deployments and roles match the approved budget.
- [ ] API/SPA IDs are persisted; only the current operator received the automatic manager assignment.
- [ ] Exact hosted callback exists and any pre-existing redirect URIs remain intact.

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

## Phase 4 — Review default extraction and answers

| Capability | Required settings | Additional proof |
|---|---|---|
| Content Understanding custom schema | `DEPLOY_CONTENT_UNDERSTANDING=true` by default; approved region; configured completion/embedding deployments and analyzer ID | Authorized whole document yields validated fields, confidence and source grounding; missing numeric grounding abstains. |
| Responses | `DEPLOY_OPENAI=true` by default; configured model/version/deployment/SKU/capacity | Model supports Responses structured output; unsupported claims abstain. |
| Both | Both sets plus reviewed regions and budget | One provider failure cannot silently switch the other to a simulated path. |

> [!IMPORTANT]
> Cloud provisioning supplies model defaults; overrides remain available below. Verify current model availability, retirement, deployment SKU and structured-output support for your subscription. Defaults do not reserve quota or guarantee regional capacity. A resource account without a compatible deployment is not a working provider.

<details><summary><b>Provider override recipe — not required for the default deployment</b></summary>

```powershell
azd env set DEPLOY_CONTENT_UNDERSTANDING true
azd env set CONTENT_UNDERSTANDING_LOCATION '<approved-extraction-region>'
azd env set CONTENT_UNDERSTANDING_ANALYZER_ID 'document_metrics'
# Bootstrap resolves the actual Azure CLI user's setup identity automatically.
# Optional: override only when deliberately using a different authorized setup caller.
# azd env set CONTENT_UNDERSTANDING_SETUP_PRINCIPAL_ID '<intentional-setup-caller-object-id>'
# azd env set CONTENT_UNDERSTANDING_SETUP_PRINCIPAL_TYPE 'User'
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

These placeholders show how to override the shipped defaults, not values to paste unchanged. Each capacity's units depend on its chosen deployment; inspect current quota and pricing before overriding. For direct `deploy.ps1` use, supply the same names as process environment settings. Bootstrap automatically resolves/persists `CONTENT_UNDERSTANDING_SETUP_PRINCIPAL_ID` and `CONTENT_UNDERSTANDING_SETUP_PRINCIPAL_TYPE` for the actual Azure CLI user; these are not mandatory manual inputs. They deliberately differ from azd's reserved principal substitutions because the two CLIs may use different users in the same tenant. Override only for an intentional authorized setup caller. You can explicitly set `DEPLOY_OPENAI=false` to evaluate extraction independently, or `DEPLOY_CONTENT_UNDERSTANDING=false` to omit cloud extraction. Neither is the complete default deployment.

</details>

The extraction adapter uses a [custom Content Understanding analyzer](https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/concepts/analyzer-reference) with stable GA API `2025-11-01`; it is not a layout-only call. Fields use `method: extract`, with confidence/source grounding enabled. The answer adapter independently uses the [Responses API](https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/responses) with schema under [text.format](https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/structured-outputs).

### Custom-analyzer setup and lifecycle

| Setup step | Responsible component | Stop condition |
|---|---|---|
| Provision dedicated extraction resource | Shared Bicep or manual runner: AIServices S0, managed identity bindings, default completion and embedding deployments | Invalid override, unsupported region, unavailable quota or insufficient role-assignment permission. |
| Initialize model defaults | `scripts/configure-content-understanding.mjs`, invoked by deployment hooks/shared runner | Existing model-name mapping differs: do not overwrite it. Missing entries alone are merged using `application/merge-patch+json`. |
| Create domain-derived analyzer | Same setup script; data-plane analyzer API, not an ARM analyzer resource | Existing analyzer schema differs: do not replace it automatically. |
| Invoke extraction | Runtime submits bytes to the configured analyzer with explicit model-name → deployment-name mappings | Invalid fields, absent numeric source spans, failed analysis or unsafe poll location. |

Use a **new** `CONTENT_UNDERSTANDING_ANALYZER_ID` when changing the extraction schema/domain or model configuration, or perform a separately reviewed external migration. The setup path never silently replaces an existing analyzer or conflicting resource default. The operator setup principal needs Cognitive Services User as well as the runtime identity; allow for role propagation before retrying setup.

The [model setup quickstart](https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/quickstart/use-rest-api) and [custom analyzer documentation](https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/tutorial/create-custom-analyzer) describe these distinct data-plane prerequisites. Shipped deployment defaults remain configurable and quota-dependent. Preview agentic analysis is not enabled.

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

The no-argument Azure-CLI-backed alternative prompts for missing explicit target values and uses the same default-on resources/identity bootstrap:

```powershell
.\scripts\deploy.ps1
```

For preselected target values, use:

```powershell
.\scripts\deploy.ps1 -TenantId $TenantId -SubscriptionId $SubscriptionId `
  -EnvironmentName $EnvironmentName -Location $Location
```

The Azure-CLI-backed script invokes the same bootstrap and identity helpers, verifies/authenticates the explicit target, deploys `infra/azd.bicep`, completes the owned managed-SPA callback before Content Understanding setup, remotely builds the image, updates the application and verifies health. It installs locked Node dependencies with `npm ci` only when required application dependencies are absent. It cannot grant directory privileges or model quota. Externally managed compatible identity can be supplied with `AUTO_CONFIGURE_ENTRA=false` and operator-maintained callback/roles; no separate Azure Developer CLI deployment is required for this entry point.

</details>

| Operation | Safety gate | Recommendation |
|---|---|---|
| Re-deploy application | Confirm intended environment and image | Rerun tests after configuration changes. |
| Reset local state | Local synthetic manager only | Do not treat it as a cloud reset mechanism. |
| `azd down --purge` | Confirm target, resource list and retention approval first | Disposable Azure resources only; destructive and potentially irreversible. Directory app registrations/service principals survive. |
| Directory identity cleanup | Verify exact persisted API/SPA application IDs, ownership tags, tenant and dependants | Explicitly delete only demo-owned disposable apps/service principals; never remove reused/shared identity automatically. |
| Keep environment | Budget and cleanup owner remain assigned | Review database and log retention costs. |

<details><summary><b>Explicit directory cleanup — separate from azd down</b></summary>

After confirming the same intended tenant/subscription with `az account show`, inspect both persisted `ENTRA_AUDIENCE` and `ENTRA_CLIENT_ID` in the azd environment or `entraAudience` / `entraClientId` in the ignored local reference file. Inspect each application and its enterprise application/service principal in Entra before deleting anything. Confirm ownership tags and that no other environment depends on it. Use Entra App registrations and Enterprise applications to remove only those verified disposable objects; service principals/assignments must be accounted for as part of the same cleanup review.

Deleting directory identity invalidates sign-in and future reuse even if Azure resources remain. Conversely, `azd down`/resource-group deletion alone does not remove identity, preauthorization or user app-role assignment objects. No automatic directory-delete hook is provided.

</details>

Next: [Manual deployment equivalent](./03b-manual-deployment.md).

*Last updated: 2026-11-17*
