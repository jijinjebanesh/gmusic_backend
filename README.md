# mornye-gdrive-bridge (GMusic backend)

Streams audio from Google Drive, gates login with MongoDB Atlas, and runs
**either** as a local Node bridge (PC) **or** as a Vercel serverless deployment.
All GMusic accounts use one common Google Drive library by default. Per-user
Drive connections are an optional deployment mode selected with
`GMUSIC_DRIVE_MODE=per_user`.

Secrets (`credentials.json`, `.env`, `data/token.json`) are git-ignored and
never belong in the Flutter app or a public repository. Never put the Google
OAuth client secret anywhere but this service.

## Routes

| Route | Purpose |
| --- | --- |
| `GET /health` | liveness; reports `authMode`, `driveMode`, and `runtime` |
| `POST /api/v1/auth/register` · `POST /api/v1/auth/login` | account sign-up / sign-in → 30-day session token |
| `POST /api/v1/auth/logout` · `GET /api/v1/auth/me` | session management |
| `POST /api/v1/drive/oauth/start` · `GET /api/v1/drive/oauth/callback` | starts authorization for the common Drive by default; per-user PKCE is optional |
| `POST /api/v1/drive/oauth/disconnect` | per-user mode: revoke and remove the current user's Google connection |
| `GET /api/v1/tracks` | Compatible live Drive listing (paginated) with ticket URLs |
| `GET /api/v1/drive/status` · `GET /api/v1/drive/sync/status` | Drive authorization and persistent index status |
| `POST /api/v1/drive/sync` | Runs one bounded full-index or incremental-change batch |
| `GET /api/v1/catalog/tracks` · `GET /api/v1/catalog/tracks/:id` | Paginated indexed tracks with normalized tags and stream tickets |
| `POST /api/v1/catalog/tracks/resolve` | Resolves up to 500 track IDs for playback handoff |
| `GET /api/v1/catalog/tracks/:id/lyrics` | Embedded lyrics from indexed audio tags; returns `lyrics_not_found` when absent |
| `GET /api/v1/playback/state` · `POST /api/v1/playback/poll` | Account-scoped connected devices and the active playback session |
| `POST /api/v1/playback/handoff` · `POST /api/v1/playback/commands` | Transfers playback or queues a command for the active device |
| `POST /api/v1/playback/commands/:commandId/ack` | Acknowledges remote command execution |
| `GET /api/v1/artists` · `GET /api/v1/artists/:id/*` | Indexed artist aggregates, tracks and albums |
| `GET /api/v1/albums` · `GET /api/v1/albums/:id/*` | Indexed album aggregates and ordered tracks |
| `GET /api/v1/genres` · `GET /api/v1/genres/:id/tracks` | Indexed genres and matching tracks |
| `GET /api/v1/search` | Indexed track, artist and album search |
| `GET /stream/:ticket` · `GET /art/:ticket` | short-lived audio / cover-art tickets (no auth header, usable by `<img>` and the player) |
| `GET/PUT/DELETE /api/v1/favorites/:trackId` · `GET/POST /api/v1/recent` | per-user likes and listening history in Atlas |
| `GET/POST/DELETE /api/v1/search-history` · `DELETE /api/v1/search-history/:query` | per-user, bounded, de-duplicated search history |
| `GET/PUT/DELETE /api/v1/followed-artists/:artistId` | per-user followed artists |
| `GET/PUT/DELETE /api/v1/saved-albums/:albumId` | per-user saved albums |
| `GET/POST/PUT/DELETE /api/v1/playlists` | per-user playlists with ordered track IDs and descriptions |

Every `/api/v1` call other than `auth/*` requires `Authorization: Bearer
<session token or MORNYE_API_TOKEN>`. Scopes are read-only
(`drive.readonly`). No file writes or deletion are exposed. In per-user mode,
catalog, index, artwork, and stream access are scoped to the authenticated
account; a missing user connection never falls back to the shared Drive
account. MongoDB is the common application database for accounts, the shared
catalog, and user-owned favorites/history/playlists. Per-user OAuth and
encrypted token persistence are only required in optional per-user Drive mode.
The OAuth callback is the only public `/api/v1` exception beyond `auth/*`; it
accepts only a valid, database-backed, one-use state bound to the initiating
user.

Connected playback requires a signed-in personal account; owner-token mode is
not accepted. Active devices heartbeat every two seconds and are considered
offline after 20 seconds without a poll. Handoff transfers the queue and
playback position, and the receiving device resolves track IDs into fresh
stream tickets. Queues are capped at 500 tracks.

Ticketed and authenticated media routes allow cross-origin resource loading so
the Flutter web app can play audio and display artwork from a separate local
port. Other routes keep Helmet's default resource policy.

## Local run (PC bridge)

```bash
npm install
# .env with MORNYE_API_TOKEN, GDrive creds (credentials.json), MONGO_URI...
npm start                   # http://127.0.0.1:43821
```

The API binds to loopback by default. Android over USB uses
`adb reverse tcp:43821 tcp:43821`; LAN clients need `HOST=0.0.0.0` plus a
private-profile firewall rule (do not expose the port to the internet).

## Deploy to Vercel

1. Push this repo to GitHub, import it at vercel.com (framework preset:
   **Other** — `api/index.js` is detected automatically).
2. Add the environment variables below (Settings → Environment Variables).
3. In Google Cloud Console → Credentials → your OAuth 2.0 client, add
   `https://gmusicbackend.vercel.app/` to **Authorized redirect URIs** (or the
   exact `GDRIVE_REDIRECT_URI` value). The backend uses Vercel's stable
   production domain by default, not a deployment-specific preview URL.
4. Connect the common Google Drive account once from GMusic Settings. The
   backend stores its OAuth token centrally; every signed-in GMusic account
   browses the same indexed catalog.

Two gotchas that produce the `ENOENT ... open 'D:/jaip/credentials.json'`
boot crash, if env vars are set to local PC values:

- `GDRIVE_CREDENTIALS` / `GDRIVE_TOKEN_JSON` must hold the **file contents**
  (inline JSON), not a filesystem path.
- Atlas Network Access must allow the deployment's egress IP. Do not use
  `0.0.0.0/0` in production; use a fixed-egress deployment, private network,
  or a restricted proxy rather than opening MongoDB to every IP.

### Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `MORNYE_API_TOKEN` | yes | ≥32 random chars; owner-token fallback + HMAC key for OAuth state |
| `MONGO_URI` | yes | Atlas URI; required for login, the shared catalog, and user-owned app data |
| `REQUIRE_MONGO` | production recommended | Set `true` to fail startup when `MONGO_URI` is absent. Vercel deployments require MongoDB automatically; a configured but unreachable Atlas also fails startup instead of downgrading to token-only mode. |
| `MONGO_DB` | no | defaults to `Gmusic` |
| `GDRIVE_CREDENTIALS` | yes | inline JSON of the OAuth client (`{"installed":{...}}`) — paste the file *contents*, never a path. A Windows path like `D:/jaip/credentials.json` exists only on the PC and crashes boot on a serverless host. With no credentials the service still boots (login works); Drive routes answer 428 `google_drive_not_connected` until it is set. |
| `GMUSIC_DRIVE_MODE` | no | defaults to `shared`; set exactly to `per_user` only when each GMusic account must connect a separate Drive |
| `GDRIVE_REDIRECT_URI` | no | common-Drive callback; defaults to `https://$VERCEL_PROJECT_PRODUCTION_URL/` on Vercel (falls back to `VERCEL_URL`) or `http://localhost:43821/` locally |
| `GDRIVE_TOKEN_JSON` | no | optional pre-authorized common-Drive token JSON; otherwise authorize the shared Drive once in Settings |
| `GDRIVE_TOKEN_ENCRYPTION_KEY` | per-user mode only | 32 random bytes encoded as base64 or 64 hex characters; stable and private, changing it requires each user to reconnect |
| `GDRIVE_USER_REDIRECT_URI` | per-user mode only | defaults to `https://$VERCEL_PROJECT_PRODUCTION_URL/api/v1/drive/oauth/callback` on Vercel (falls back to `VERCEL_URL`) or `http://localhost:43821/api/v1/drive/oauth/callback` locally; register this exact URL with Google |

Do not print or paste OAuth tokens or the encryption key into logs, shell
history, chat, or source control.

For local bridge development, omitting `MONGO_URI` explicitly selects token-only
mode; account login and user-owned persistence are unavailable in that mode.
Production deployments must configure Atlas and should set `REQUIRE_MONGO=true`.
The `/health` response reports `authMode` and `database` so operators can verify
the active mode without exposing connection details.

The common Drive's initial index is resumable and processes a bounded metadata
page per `POST /api/v1/drive/sync` call. Repeat the call until the status is
`completed`; later calls apply incremental Drive changes. Audio tags are parsed
from bounded stream heads; formats that keep metadata at the end of the file
may have partial metadata.

### Optional per-user Drive mode

Set `GMUSIC_DRIVE_MODE=per_user` only if separate Drive libraries are desired.
Each GMusic user then connects their own Google account; tokens, sync cursors,
catalog records, artwork, and stream tickets are owner-scoped. The common
library remains the default and is not copied into per-user catalogs.

### Atlas connection from this network

`mongodb+srv://` fails when the local resolver refuses SRV lookups
(`querySrv ECONNREFUSED`). Resolve the three shard hosts out-of-band and use
a direct-host URI:

```text
mongodb://<user>:<pass>@<shard-00>:27017,<shard-01>:27017,<shard-02>:27017/<db>?ssl=true&replicaSet=<replicaSet>&authSource=admin&retryWrites=true&w=majority
```

If auth still fails, reset the DB user in Atlas → Database Access before
retrying — pasted passwords frequently carry sentence punctuation.

## Serverless caveats

- `api/index.js` runs with `maxDuration: 60` (Vercel Hobby ceiling). Long
  audio streams from a slow mobile connection can hit it; the local bridge is
  the unlimited fallback.
- Stream/art tickets are stateless HMAC-signed and work across serverless
  instances; each ticket expires after eight hours.
- Artwork bytes are cached in MongoDB with a size cap and TTL; no thumbnails
  are generated.
- Set every env var above in Vercel; nothing secret is committed.

## Tests

```bash
npm test    # node --test, runs the bridge suite
```
