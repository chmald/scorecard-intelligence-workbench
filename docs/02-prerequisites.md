[README](../README.md) › [Reproduce](./00-reproduce-this-demo.md) › Prerequisites

# 02 — Prerequisites

<p>
<img src="./assets/icons/resource-group.svg" width="40" alt="Resource group"/>&nbsp;
<img src="./assets/icons/entra-id.svg" width="40" alt="Microsoft Entra ID"/>&nbsp;
<img src="./assets/icons/cosmos-db.svg" width="40" alt="Azure Cosmos DB"/>&nbsp;
<img src="./assets/icons/cost-management.svg" width="40" alt="Cost Management"/>
</p>

![Default local](./assets/badges/default.svg) ![Cloud opt-in](./assets/badges/opt-in.svg) ![Cloud static only](./assets/badges/static-only.svg)

This checklist is for the person preparing a workstation or an isolated Azure evaluation environment. Local rehearsal needs no Azure account. The hosted path additionally needs an explicitly approved tenant/subscription, role-bearing application identity and resource permissions. Do not equate the ability to create a resource with permission to process organizational documents.

## At a glance

| | Gate | Ready means |
|---|---|---|
| <img src="./assets/icons/dev-console.svg" width="24" alt="Console"/> | Workstation | Node.js 24+, npm lockfile install and PowerShell 7 for scripts. |
| <img src="./assets/icons/entra-id.svg" width="24" alt="Identity"/> | Cloud user access | Existing single-tenant API plus public SPA registrations, delegated scope/consent and reviewer/manager/auditor roles. |
| <img src="./assets/icons/managed-identity.svg" width="24" alt="Managed identity"/> | Runtime access | User-assigned identity has only the required data roles. |
| <img src="./assets/icons/cost-management.svg" width="24" alt="Cost"/> | Approval | Region, quota, budget, retention and deletion owner agreed. |

## Readiness map

[![Prerequisite map](./assets/prerequisites-map.png)](./assets/prerequisites-map.png)

<sub>Editable source: [prerequisite map](./assets/prerequisites-map.drawio).</sub>

| Path | Required tools | Not required | Recommendation |
|---|---|---|---|
| Local application | Node.js 24+, npm, browser | Azure subscription, Docker, model deployment | Start here. |
| Documentation checks | Python 3; draw.io desktop to re-export | Cloud credentials | Use local offline icons and badges. |
| Azure fast path | PowerShell 7, Azure CLI with Container Apps support, Azure Developer CLI | Local Docker daemon for remote build | Prefer `azd up` after target verification. |
| Manual cloud | Same Azure tools; Portal for visible steps | Bicep execution in manual mode | Use a separate environment from the IaC path. |

## Identity and permissions

| Resource / principal | Required access | Why |
|---|---|---|
| <img src="./assets/icons/resource-group.svg" width="24" alt="Resource group"/> Deployment operator | Resource creation and provider registration in intended subscription | Creates the resource group and hosted foundation. |
| <img src="./assets/icons/entra-id.svg" width="24" alt="Role assignments"/> Role-assignment operator | Authorization to assign required Azure roles | Contributor alone is not blanket role-assignment permission. |
| <img src="./assets/icons/app-registrations.svg" width="24" alt="API registration"/> API application | Single-tenant v2 API audience GUID; delegated scope and Users/Groups roles `reviewer`, `manager`, `auditor` | Scope consent and app-role assignments are separate requirements. |
| <img src="./assets/icons/app-registrations.svg" width="24" alt="SPA registration"/> Public SPA client | Separate client ID; SPA-platform redirect `<appUrl>/auth/callback`; delegated permission to this API | Browser uses authorization code + S256 PKCE without a client secret. |
| <img src="./assets/icons/container-registry.svg" width="24" alt="Registry"/> Runtime identity | `AcrPull` on the registry | Pull image without registry admin credentials. |
| <img src="./assets/icons/cosmos-db.svg" width="24" alt="Cosmos DB"/> Runtime identity | Cosmos DB Built-in Data Contributor scoped appropriately | Read/write the workbench state through the NoSQL data plane. |
| <img src="./assets/icons/content-understanding.svg" width="24" alt="Azure Content Understanding"/> Runtime identity and setup principal, if enabled | Cognitive Services User on the dedicated Content Understanding resource | Runtime analyzes authorized sources; setup configures missing model defaults and creates the custom analyzer without service keys. |
| <img src="./assets/icons/azure-openai.svg" width="24" alt="Azure OpenAI"/> Runtime identity, if enabled | Cognitive Services OpenAI User on model resource | Invoke the configured deployment. |

Managed identity does not replace user authentication. The server validates API access tokens; the managed identity separately authenticates downstream service calls. See [claims validation](https://learn.microsoft.com/en-us/entra/identity-platform/claims-validation), [Container Apps identity](https://learn.microsoft.com/en-us/azure/container-apps/managed-identity) and [Cosmos data-plane roles](https://learn.microsoft.com/en-us/azure/cosmos-db/nosql/how-to-connect-role-based-access-control).

> [!IMPORTANT]
> App registrations, delegated consent, redirect URI and user/group role assignments are not provisioned automatically. Complete [the identity setup](./03-deployment.md#phase-1--prepare-configuration-and-application-identity), then test actual hosted sign-in. No client secret, Blob token store or platform-managed auth configuration is required by this PKCE baseline.

## Region alignment — publication snapshot 2026-11-17

| Tier | Selection strategy | Consequence | Recommendation |
|---|---|---|---|
| Tier 1 | Same approved region for runtime, database and optional AI where available | Simpler residency and latency review | Preferred when your chosen deployment is available and quota is granted. |
| Tier 2 | Runtime/database together; approved separate region for optional AI | Cross-region data transfer and latency need review | Accept only with explicit data-residency approval. |
| Tier 3 | Baseline hosted app without optional AI | Real local parsers and deterministic answers remain available | Use when model or extraction capacity is unavailable; never simulate cloud success. |

No region is a guaranteed default. Product support, deployment type, model/version and subscription quota are separate checks. Model availability must be checked for the exact operator-selected deployment, not a guessed model family.

The tier labels above are this pattern's deployment recommendations, not service-assigned regional tiers. The [Content Understanding region publication](https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/language-region-support), checked 2026-11-17, lists `australiaeast`, `canadacentral`, `eastus`, `eastus2`, `japaneast`, `southcentralus`, `southeastasia`, `swedencentral`, `uksouth`, `westeurope`, `westus` and `westus3`. This is not a quota reservation or evidence that your selected completion/embedding versions and deployment SKUs are available there.

| Component | Availability gate | Publication status |
|---|---|---|
| <img src="./assets/icons/container-apps.svg" width="24" alt="Container Apps"/> Container Apps environment | Region/provider support and regional capacity | ![Static only](./assets/badges/static-only.svg) Verify at deployment time. |
| <img src="./assets/icons/cosmos-db.svg" width="24" alt="Cosmos DB"/> Cosmos DB for NoSQL | Account creation policy, region and throughput quota | ![Static only](./assets/badges/static-only.svg) Verify at deployment time. |
| <img src="./assets/icons/content-understanding.svg" width="24" alt="Azure Content Understanding"/> Content Understanding | Supported region, AIServices S0 account, two compatible completion/embedding deployments, custom analyzer and role | ![GA API](./assets/badges/ga.svg) ![Opt-in](./assets/badges/opt-in.svg) API `2025-11-01`; no live validation. |
| <img src="./assets/icons/azure-openai.svg" width="24" alt="Azure OpenAI"/> Azure OpenAI | Exact model/version/SKU, Responses + structured-output support, quota | ![Opt-in](./assets/badges/opt-in.svg) No pinned deployment. |

<details><summary><b>Availability checks after explicit authentication</b></summary>

```powershell
# First complete Phase 0 of the deployment runbook.
az provider show --subscription $SubscriptionId --namespace Microsoft.App --query registrationState -o tsv
az provider show --subscription $SubscriptionId --namespace Microsoft.DocumentDB --query registrationState -o tsv
az provider show --subscription $SubscriptionId --namespace Microsoft.CognitiveServices --query registrationState -o tsv
az account list-locations --subscription $SubscriptionId -o table
az cognitiveservices account list-skus --subscription $SubscriptionId --kind AIServices --location $ContentUnderstandingLocation -o table
# After optional account creation, inspect the account's supported models.
az cognitiveservices account list-models --subscription $SubscriptionId --resource-group $ResourceGroup --name $OpenAIAccount -o json
```

These are operator-run commands; none were run to author these docs. A locations list does not prove service/model availability. Recheck [Content Understanding region support](https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/language-region-support), [supported model deployments](https://learn.microsoft.com/en-us/azure/ai-services/content-understanding/concepts/models-deployments), [Azure OpenAI model documentation](https://learn.microsoft.com/en-us/azure/ai-services/openai/concepts/models), [retirement guidance](https://learn.microsoft.com/en-us/azure/ai-services/openai/concepts/model-retirements) and the account quota page.

</details>

## Resource footprint and budget

| Resource | Shipped choice | Cost driver | Recommendation |
|---|---|---|---|
| <img src="./assets/icons/container-apps.svg" width="24" alt="Container Apps"/> Container Apps | Bounded single replica | Active CPU/memory and environment configuration | Stop/delete disposable environments after use. |
| <img src="./assets/icons/container-registry.svg" width="24" alt="Registry"/> Registry | Basic, admin disabled | Registry storage and remote builds | Keep only necessary test image tags. |
| <img src="./assets/icons/cosmos-db.svg" width="24" alt="Cosmos DB"/> Cosmos DB | Standard provisioned throughput; default 400 RU/s | Provisioned throughput and stored data | This is a template choice, not a universal minimum for every Cosmos mode. |
| <img src="./assets/icons/log-analytics.svg" width="24" alt="Logs"/> Log Analytics | PerGB2018, default 30-day retention | Log ingestion and retention | Do not log prompts or raw documents. |
| <img src="./assets/icons/content-understanding.svg" width="24" alt="Azure Content Understanding"/> Optional extraction | Dedicated AIServices S0 account, operator-selected completion and embedding deployments | Extraction/contextualization plus model token usage; deployment type/capacity | Authorize whole documents for model processing; budget independently from answers. |
| <img src="./assets/icons/azure-openai.svg" width="24" alt="Model"/> Optional model | OpenAI resource S0 + explicitly supplied model SKU | Selected deployment, capacity and usage | No model cost is implied without selection. |

No dollar estimate is invented here. Build a dated estimate in the [Azure pricing calculator](https://azure.microsoft.com/en-us/pricing/calculator/) using your region, retention, throughput, pages and token volumes. Budget alerts are notifications, not a hard spend cap.

For custom extraction, plan two distinct supported model deployments on the dedicated extraction account: completion and embedding. Supply each model's exact name, current version, deployment name, SKU and capacity. The data-plane setup script fills missing resource-default mappings and creates the analyzer; it does not overwrite existing mappings or replace a different schema. Changing domain/schema/model choices needs a new analyzer ID or a deliberate external migration. The separate optional Responses deployment is not automatically reused for extraction.

## Scope and starting targets

[![Scope and targets](./assets/scope-and-targets.png)](./assets/scope-and-targets.png)

<sub>Editable source: [scope and targets](./assets/scope-and-targets.drawio).</sub>

> [!WARNING]
> Tiny synthetic fixtures are not a capacity or quality benchmark. Proposed zero-disclosure and citation-resolution goals are starting targets to test, not results from an organizational corpus.

The local JSON store is for one trusted process. Cosmos stores a bounded workbench state; do not treat it as an unlimited source-file archive. Review request limits, database item-size behavior and extraction timeouts in [configuration](./08-configuration-reference.md) before increasing sample sizes. Scans and chart-only values require additional cloud evaluation; never convert an empty extraction into invented measurements.

## Final pre-flight checklist

| Check | Local | Azure |
|---|---|---|
| Runtime and locked install | ☐ Node 24+, `npm ci` | ☐ Remote build supported. |
| Neutral data only | ☐ Generated synthetic files | ☐ Approved retention and data handling. |
| Authentication | ☐ Loopback synthetic session | ☐ API app roles, tenant and audience verified. |
| Service permissions | Not needed | ☐ Registry pull and Cosmos data roles. |
| Optional AI | Disabled by default | ☐ Region, explicit completion/embedding deployments, quota, runtime/setup roles and whole-document authorization. |
| Costs | No Azure spend | ☐ Budget, cleanup owner and deletion scope. |
| Acceptance | ☐ Local test output saved | ☐ Cloud validation remains pending until run. |

Next: [Deployment](./03-deployment.md).

*Last updated: 2026-11-17*
