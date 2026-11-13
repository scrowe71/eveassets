# EveAssets

Browser-only EVE Online asset tracker for your characters and corporations. It runs on Cloudflare Pages with no server: login uses EVE SSO with PKCE (no client secret), and all tokens and cached assets stay in your browser (localStorage + IndexedDB).

## Features
- Log in several characters and see all their assets together. Tick or untick owners to include or exclude them.
- Corporation assets appear automatically for any logged-in character with the **Director** role, labelled by your corp's **hangar division names**.
- Resolves stations, Upwell structures (where the character has docking access), ship and container names, and fitted, cargo and drone-bay contents.
- Values each stack at **Jita sell**, **Jita buy** (Fuzzwork market data) or **ESI average** prices. Blueprint copies count as 0.
- Group by location, by item type, or flat. Search, location and division filters, sortable columns.
- **Export CSV** of whatever is currently filtered.
- Cached snapshots load instantly. Each owner shows a **countdown to the next ESI update**, read from ESI's own cache-expiry time (up to 1 hour for assets). **Refresh** only re-pulls owners whose data has expired, and counts down to the next one when none are ready. Expired owners refresh automatically when the page opens.
- **Sort locations** by most ISK, least ISK, stack count or name. Each location shows its share of the total value.

## Setup

### 1. Register the EVE application
1. Go to https://developers.eveonline.com/applications and create an application named **EveAssets**.
2. Connection type: **Authentication & API Access**.
3. Scopes:
   - `esi-assets.read_assets.v1`
   - `esi-assets.read_corporation_assets.v1`
   - `esi-universe.read_structures.v1`
   - `esi-corporations.read_divisions.v1`
   - `esi-characters.read_corporation_roles.v1`
4. Callback URL: your site root **with the trailing slash**, `https://eveassets.crankyape.space/`
5. Copy the **Client ID** into `config.js`. The secret key is not used, so never put it in this repo.

### 2. Deploy on Cloudflare Pages
Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git → pick this repo.
- Framework preset: **None**
- Build command: *(leave empty)*
- Build output directory: `/`

Live address: **https://eveassets.crankyape.space/**. Add it under the Pages project's **Custom domains** tab so Cloudflare issues the certificate and routes it. Logging in from the `*.pages.dev` address won't work unless that address is also registered as a callback.

### 3. Local testing (optional)
```powershell
python -m http.server 8080
```
Open http://localhost:8080/. Login only works if the EVE app's Callback URL is `http://localhost:8080/`. The easiest approach is a second "EveAssets Dev" application with that callback, using its Client ID while testing.

## Notes
- Corp assets need the Director role. Without it the corp entry simply doesn't appear.
- Structures where the logged-in character has no docking access show as "Structure (no docking access)". ESI won't reveal their names.
- `_headers` sets a strict Content-Security-Policy so the page can only talk to ESI, EVE SSO and Fuzzwork.
- "Remove" on a character deletes its tokens and cached assets from this browser. To fully revoke access, also remove the app at https://community.eveonline.com/support/third-party-applications/

## Files
| File | Purpose |
| --- | --- |
| `index.html`, `styles.css` | Page and styling |
| `app.js` | SSO, ESI calls, caching, rendering |
| `lib.js` | Pure logic: container walking, grouping, CSV (unit-testable) |
| `config.js` | Client ID and settings |
| `_headers` | Cloudflare Pages security headers |
