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
| `src/pe-tracker.js` | Reads the Partner Engagement Master Tracker (.xlsx in Azure Blob) so the panel can show an ARN's Sales RM, SRMs and PE RM. |
| `host.json` | Functions host settings (no `/api` route prefix). |
| `test/local.mjs` | Tests run in CI against the Azurite storage emulator. |

Partner Engagement tracker hooks inside `src/worker.js`: a `pelookup` action, a `pe` field on the `arnlookup` (Claim by ARN) answer, and a small script at the end of the page that shows the tracker line under the search box.

Azure tweaks inside `src/worker.js`: the snapshot page count reads `SNAP_STEP` from app settings (`ia=+(globalThis.process&&process.env.SNAP_STEP||8)`), and snapshot errors are also written to the `snapdiag` key so `/__health` can show them.

## Settings (Azure → Wylth-ghl-SubApps → Environment variables)

`GHL_API_TOKEN`, `GHL_LOCATION_ID`, `GHL_SSO_KEY`, `GHL_SSO_KEY_ENGAGE`, `SNAP_STEP` (100), `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` (Microsoft sign-in, see below), `AzureWebJobsStorage` (data lives in storage account `webappprod01`, container `panelkv`). Secrets are never committed here.

**Partner Engagement tracker in search (optional settings):** `TRACKER_CONTAINER_SAS_URL` (a **read-only** SAS URL for the `list` container in storage account `distributorbucket`) and, if the file name ever changes, `TRACKER_BLOB` (default `Partner_Engagement_Master_Tracker.xlsx`). The panel reads the *Partner Master* sheet (ARN, Partner, Sales RM, Prm SRM, Sec SRM, PE RM) and keeps it for 10 minutes, so re-uploading the file with Overwrite updates the panel within 10 minutes. Typing an ARN in the leads search box shows a line with that partner's mapping, and **Claim by ARN** shows it too. Without the setting nothing changes. Server side: `env.PE_LOOKUP(arn)` and the `pelookup` action (any signed-in user, up to 20 ARNs).

**Daily call scorecard feed (optional settings):** `SCORECARD_FEED_KEY` (a long random string, 16+ characters) and `SCORECARD_ADMIN_EMAIL` (the work email of a panel admin). With both set, the daily report job can `POST https://salespanel.wylth.com/api/feed/scorecard` with header `X-Feed-Key: <key>` and JSON `{date, reps:[...], feedback:[...]}` (same shape as the file the admin 'Import scorecard' button takes). It lands in the Call analysis tab, each RM sees their own row. Without these settings the route answers 401.

## Signing in

- **Inside GHL** (left menu): GHL's own sign-in, as before. The **Open in new tab ↗** button opens the same session in a browser tab.
- **Directly at salespanel.wylth.com**: the page sends you to **Sign in with Microsoft** (wylth.com accounts in the company tenant only). Your Microsoft email must match an active GHL user; you then get the same 8-hour session and the same role and visibility as in GHL. Code: `src/ms-auth.js`. Microsoft app registration: "Wylth Sales Panel", redirect `https://salespanel.wylth.com/auth/ms/callback`. The client secret expires after 2 years; renew it in Entra ID and update `MS_CLIENT_SECRET`.

## Running tests locally

```
npm ci
npx azurite-blob --silent --location /tmp/azdata --blobPort 10000 &
npm test
```
