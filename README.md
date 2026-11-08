# mornye-gdrive-bridge (GMusic backend)

Streams audio from a Google Drive account, gates per-user login with MongoDB
Atlas, and runs **either** as a local Node bridge (PC) **or** as a Vercel
serverless deployment — same code, same routes.

Secrets (`credentials.json`, `.env`, `data/token.json`) are git-ignored and
never belong in the Flutter app or a public repository. Never put the Google
OAuth client secret anywhere but this service.

## Routes

| Route | Purpose |
| --- | --- |
| `GET /health` | liveness; reports `authMode` (`user_login`/`token`) and `runtime` |
| `POST /api/v1/auth/register` · `POST /api/v1/auth/login` | account sign-up / sign-in → 30-day session token |
| `POST /api/v1/auth/logout` · `GET /api/v1/auth/me` | session management |
| `GET /api/v1/tracks` | Drive audio listing (paginated) with ticket URLs |
| `GET /stream/:ticket` · `GET /art/:ticket` | short-lived audio / cover-art tickets (no auth header, usable by `<img>` and the player) |
| `GET/PUT/DELETE /api/v1/favorites/:trackId` · `GET/POST /api/v1/recent` · playlists CRUD | per-user data in Atlas |

Every `/api/v1` call other than `auth/*` requires `Authorization: Bearer
<session token or MORNYE_API_TOKEN>`. Scopes are read-only
(`drive.readonly`). No file writes or deletion are exposed.

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
3. In Google Cloud Console → Credentials → your OAuth 2.0 client, add the
   Vercel deployment URL (`https://<project>.vercel.app/`) to **Authorized
   redirect URIs**.
4. Connect Drive once from the app: the OAuth callback lands on the Vercel
   URL and the token is stored in Atlas (`gdrive_tokens`), so it survives cold
   starts and redeploys.

### Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `MORNYE_API_TOKEN` | yes | ≥32 random chars; owner-token fallback + HMAC key for OAuth state |
| `MONGO_URI` | yes | Atlas URI (see note below); drives login + token storage |
| `MONGO_DB` | no | defaults to `Gmusic` |
| `GDRIVE_CREDENTIALS` | yes | inline JSON of the OAuth client (`{"installed":{...}}`) — the repo deliberately ships no `credentials.json` |
| `GDRIVE_TOKEN_JSON` | no | pre-authorized token JSON; skips the in-app OAuth step on first deploy |
| `GDRIVE_REDIRECT_URI` | no | defaults to `https://$VERCEL_URL/` on Vercel, `http://localhost:43821/` locally |

To seed `GDRIVE_TOKEN_JSON` from a working local bridge:
`node -e "console.log(JSON.stringify(require('./data/token.json')))"`.

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
- Stream/art tickets are held in instance memory, so a cold start invalidates
  older tickets. The app refetches `/api/v1/tracks`, which mints fresh ones.
- Set every env var above in Vercel; nothing secret is committed.

## Tests

```bash
npm test    # node --test, runs the bridge suite
```
