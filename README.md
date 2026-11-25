# Wylth Sales Panel and Engagement & Cross-sell panel

The GHL left-menu panels **Sales Panel** and **Engagement & Cross-sell**, running on the Azure Function **Wylth-ghl-SubApps** (resource group Wylth-PROD, Central India).

- Live: https://salespanel.wylth.com (Sales) and https://salespanel.wylth.com/engage (Engage)
- Health check: https://salespanel.wylth.com/__health (counts and times only, no panel data)

## How a change goes live

1. Make a branch, change the code, open a **pull request** into `main`.
2. The **Test** workflow runs automatically (syntax check + storage/adapter tests).
3. **Charukant reviews and approves** the pull request, then it is merged. `main` is protected: no direct pushes, no force pushes, one approving review required.
4. The **Deploy to Azure** workflow starts and **waits** in the `production` environment. GitHub emails Charukant; open the run under **Actions** and click **Review deployments → Approve and deploy**.
5. After deploying it checks `/__health` on the live site.

To roll back: revert the pull request (GitHub's "Revert" button), and Charukant merges the revert.

## What's in here

| Path | What it is |
|---|---|
| `src/worker.js` | The panel itself: pages, API, GHL calls, snapshot sync. Same code that ran on Cloudflare (Arpit's bundle), unchanged apart from two small Azure tweaks marked below. |
| `src/core.js` | Azure adapter: Blob storage in place of Cloudflare KV, request handling, gzip, `/__health`. |
| `src/index.js` | Azure Functions entry: one HTTP function (`panel`) for every path, and a timer (`snapSync`) every 5 minutes. |
| `host.json` | Functions host settings (no `/api` route prefix). |
| `test/local.mjs` | Tests run in CI against the Azurite storage emulator. |

Azure tweaks inside `src/worker.js`: the snapshot page count reads `SNAP_STEP` from app settings (`ia=+(globalThis.process&&process.env.SNAP_STEP||8)`), and snapshot errors are also written to the `snapdiag` key so `/__health` can show them.

## Settings (Azure → Wylth-ghl-SubApps → Environment variables)

`GHL_API_TOKEN`, `GHL_LOCATION_ID`, `GHL_SSO_KEY`, `GHL_SSO_KEY_ENGAGE`, `SNAP_STEP` (100), `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` (Microsoft sign-in, see below), `AzureWebJobsStorage` (data lives in storage account `webappprod01`, container `panelkv`). Secrets are never committed here.

## Signing in

- **Inside GHL** (left menu): GHL's own sign-in, as before. The **Open in new tab ↗** button opens the same session in a browser tab.
- **Directly at salespanel.wylth.com**: the page sends you to **Sign in with Microsoft** (wylth.com accounts in the company tenant only). Your Microsoft email must match an active GHL user; you then get the same 8-hour session and the same role and visibility as in GHL. Code: `src/ms-auth.js`. Microsoft app registration: "Wylth Sales Panel", redirect `https://salespanel.wylth.com/auth/ms/callback`. The client secret expires after 2 years; renew it in Entra ID and update `MS_CLIENT_SECRET`.

## Running tests locally

```
npm ci
npx azurite-blob --silent --location /tmp/azdata --blobPort 10000 &
npm test
```
