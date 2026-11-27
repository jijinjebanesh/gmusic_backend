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
| `GET /health` | liveness; reports `authMode`, `driveMode`, `runtime`, Socket.IO mode, and Redis readiness |
| `POST /api/v1/auth/register` · `POST /api/v1/auth/login` | account sign-up / sign-in → 30-day session token |
| `POST /api/v1/auth/logout` · `GET /api/v1/auth/me` | session management |
| `POST /api/v1/drive/oauth/start` · `GET /api/v1/drive/oauth/callback` | starts authorization for the common Drive by default; per-user PKCE is optional |
| `POST /api/v1/drive/oauth/disconnect` | per-user mode: revoke and remove the current user's Google connection |
| `GET /api/v1/tracks` | Compatible live Drive listing (paginated) with stream and browser-safe artwork ticket URLs |
| `GET /api/v1/drive/status` · `GET /api/v1/drive/sync/status` | Drive authorization and persistent index status |
| `POST /api/v1/drive/sync` | Runs one bounded full-index or incremental-change batch |
| `GET /api/v1/catalog/tracks` · `GET /api/v1/catalog/tracks/:id` | Paginated indexed tracks with normalized tags, stream URLs, and browser-safe artwork URLs |
| `POST /api/v1/catalog/tracks/resolve` | Resolves up to 500 track IDs for playback handoff |
| `GET /api/v1/tracks/:id/quality/:quality` | Resolves `original`, `low`, `medium`, or `high`; pre-generated qualities return `202` while the laptop worker is processing |
| `GET /api/v1/renditions/:jobId` | Authenticated laptop-worker status; returns a stream URL after a Drive rendition is uploaded and recorded |
| `GET /api/v1/playback/state` · `POST /api/v1/playback/poll` | Account-scoped device registry and versioned playback session |
| `Socket.IO /api/v1/playback/socket` | Authenticated device presence, playback sync, command delivery/acknowledgments and transfers; WebSocket transport only |
| `POST /api/v1/playback/handoff` · `GET /api/v1/playback/transfers/:id` | Prepare, acknowledge and inspect a playback transfer |
| `POST /api/v1/playback/commands` · `GET/DELETE /api/v1/playback/commands/:id` | Queue, inspect or cancel an acknowledged remote command |
| `POST /api/v1/playback/commands/:commandId/ack` | Acknowledge remote command execution or transfer preparation |
| `PATCH /api/v1/playback/devices/:deviceId` · `POST .../:deviceId/disconnect` · `DELETE /api/v1/playback/devices/:deviceId` | Rename, hide/disconnect this device, or forget an offline device |
| `POST /api/v1/group-listening` · `POST /api/v1/group-listening/join` | Create a Group Listening room or join by invitation code |
| `GET /api/v1/group-listening/:sessionId` · `POST .../:sessionId/heartbeat` | Fetch room state or report readiness, clock offset, playback position and output-latency compensation |
| `POST /api/v1/group-listening/:sessionId/control` · `POST .../:sessionId/leave` | Control shared playback/queue or leave the room |
| `POST /api/v1/group-listening/:sessionId/account-call-state` | Pause or resume this account's devices in a shared room when a call interrupts playback |
| `GET /api/v1/artists` · `GET /api/v1/artists/:id/*` | Indexed artist aggregates, tracks and albums |
| `GET /api/v1/albums` · `GET /api/v1/albums/:id/*` | Indexed album aggregates and ordered tracks |
| `GET /api/v1/genres` · `GET /api/v1/genres/:id/tracks` | Indexed genres and matching tracks |
| `GET /api/v1/search` | Indexed track, artist and album search |
| `GET /stream/:ticket` · `GET /art/:ticket?quality=:quality` | short-lived original audio / cover-art tickets; artwork uses a ready rendition for the selected quality and falls back to the original |
| `GET /stream-quality/:ticket` | short-lived ticketed Google Drive MP3 rendition stream with byte-range and HEAD support |
| `GET/PUT/DELETE /api/v1/favorites/:trackId` · `GET/POST /api/v1/recent` | per-user likes and listening history in Atlas |
| `GET /api/v1/home` | ID-based quick picks, listening shelves, daily mixes and monthly recap |
| `POST /api/v1/listening-events` | Records a qualified listen (30 seconds or half the duration) or skip from the active playback device; event IDs deduplicate handoffs |
| `GET/POST/DELETE /api/v1/search-history` · `DELETE /api/v1/search-history/:query` | per-user, bounded, de-duplicated search history |
| `GET/PUT/DELETE /api/v1/followed-artists/:artistId` | per-user followed artists |
| `GET/PUT/DELETE /api/v1/saved-albums/:albumId` | per-user saved albums |
| `GET/POST/PUT/DELETE /api/v1/playlists` | per-user playlists with ordered track IDs and descriptions |

The Flutter client fetches plain and synced lyrics exclusively from LRCLIB.
Embedded audio-tag lyrics are neither indexed nor served by the backend.

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
not accepted. Clients pass the account session token in the authenticated
Socket.IO handshake (never in the URL). `device:register` authorizes the
account-scoped device room; `device:heartbeat` and `playback:sync` reconcile
against MongoDB; `playback:command` and `playback:transfer` create durable
requests; and `playback:command:ack` records execution on the active player.
`playback:changed` and `playback:command:result` are notifications, not the
source of truth. The client uses WebSocket-only transport, so Engine.IO does
not depend on HTTP long-polling stickiness.

The Socket.IO Redis adapter relays room events between instances when
`REDIS_URL` is configured and its Pub/Sub permissions pass a startup probe.
The Redis user must be allowed to publish and subscribe to Socket.IO channels.
If the probe fails, the service keeps local Socket.IO and REST polling rather
than attaching a failing adapter. The adapter does not recover missed events;
after connect or reconnect, clients fetch authoritative session, device and
queue state from MongoDB. Each playback snapshot includes the server clock
reference used by clients to render position without relying on synchronized
device clocks. `/health` reports `playbackRealtime` and `playbackRedis`;
`socketio_local` means realtime broadcasts are instance-local and clients use
the REST polling recovery path. The HTTP polling and command endpoints remain
available for recovery and compatibility. Devices are considered offline
after 12 seconds without a heartbeat. If the active device expires while
playing, the first playback-capable device to poll reserves failover and
receives a normal acknowledged handoff. It becomes the owner only after it
resolves and prepares the current track; playback then resumes from the saved
session. Other devices wait while that reservation is active. Queue metadata
can finish loading afterward.
Commands expire for execution after 60 seconds; their status and
idempotent acknowledgments are retained for 24 hours so retries do not become
`command_not_found`. Commands can be cancelled if they time out.
A transfer keeps the source authoritative until the online target resolves
the queue and acknowledges preparation. Any signed-in device for the account
can request a transfer; position and playback rate are anchored to the active
source, not the requesting controller. A failed transfer leaves the source
active. Queue revisions reject stale queue operations and prevent transfers
from switching the active owner to a stale queue. A non-owner controller's
revision is advisory; the transfer uses the current server session. Queues are
capped at 500 tracks. Commands carry the expected playback revision, while
queue edits also carry the queue revision. `setQuality` accepts `low`, `medium`,
`high`, or `original`; the active player reports the selected quality in its
next playback snapshot. Device records expire 30 days after their last
heartbeat; the Flutter device list groups offline devices by the 14-day mark.

Group Listening is separate from the account-level Connected Playback session.
Rooms have their own shared queue and timeline, support up to 20 participants,
and expire after 24 hours. Every joining account must be able to access every
track in the shared queue. Clients reuse the authenticated playback Socket.IO
connection (`group:watch`, `group:unwatch`, `group:clock`, and `group:changed`)
and the existing Redis adapter, while MongoDB remains authoritative for room
state. The backend schedules a common future start after active members report
that they are ready; clients estimate server-clock offset and correct playback
drift locally. This is best-effort synchronization, not sample-accurate or
acoustic-latency synchronization over arbitrary devices and networks.
Clients report readiness only after their stream is loaded and has at least two
seconds of buffered audio (or the full remainder of a shorter track).
Readiness reports expire after six seconds, and a scheduled start is cancelled
if any online participant reports that its stream is no longer ready.
If a room-creation response is lost, retrying creation on the same device
resumes its existing active room instead of creating a duplicate.
The group Socket.IO watch response reports whether events are shared across
instances so clients can use faster REST synchronization when Redis Pub/Sub is
unavailable.

A device claimed by a group cannot be targeted by Connected Playback commands,
handoffs, or device disconnect/forget operations. Its personal account session
is suspended on entry; leaving restores the saved personal queue paused. A
room's 24-hour expiry also expires its device claim, allowing Connected
Playback to reclaim a device after its next heartbeat.

Vercel WebSocket support requires Fluid Compute. The dedicated Socket.IO
Function is configured for a 300-second maximum duration; connections still
close at that limit, so clients reconnect with backoff and resynchronize from
MongoDB. WebSocket-only transport avoids Engine.IO polling affinity, while
Redis carries cross-instance room events. Configure Fluid Compute and the
Vercel Upstash Redis integration before deployment. If Redis is unavailable,
the health response reports that state and clients continue with REST polling.

Discovery is account-based, so authenticated GMusic clients can find each
other across networks. This registry does not discover third-party speakers or
TVs: those endpoints need their own GMusic playback client and authenticated
heartbeat. Local mDNS and QR pairing are not provided. The backend does not
proxy audio through a controller device.

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
| `REDIS_URL` | realtime cross-instance sync | Upstash Redis TLS connection URL (`rediss://...`). The Socket.IO Redis adapter uses separate publisher and subscriber clients; do not use the REST-only Upstash URL/token here. |
| `GDRIVE_CREDENTIALS` | yes | inline JSON of the OAuth client (`{"installed":{...}}`) — paste the file *contents*, never a path. A Windows path like `D:/jaip/credentials.json` exists only on the PC and crashes boot on a serverless host. With no credentials the service still boots (login works); Drive routes answer 428 `google_drive_not_connected` until it is set. |
| `GMUSIC_DRIVE_MODE` | no | defaults to `shared`; set exactly to `per_user` only when each GMusic account must connect a separate Drive |
| `GDRIVE_REDIRECT_URI` | no | common-Drive callback; defaults to `https://$VERCEL_PROJECT_PRODUCTION_URL/` on Vercel (falls back to `VERCEL_URL`) or `http://localhost:43821/` locally |
| `GDRIVE_TOKEN_JSON` | no | optional pre-authorized common-Drive token JSON; otherwise authorize the shared Drive once in Settings |
| `GDRIVE_TOKEN_ENCRYPTION_KEY` | per-user mode only | 32 random bytes encoded as base64 or 64 hex characters; stable and private, changing it requires each user to reconnect |
| `GDRIVE_USER_REDIRECT_URI` | per-user mode only | defaults to `https://$VERCEL_PROJECT_PRODUCTION_URL/api/v1/drive/oauth/callback` on Vercel (falls back to `VERCEL_URL`) or `http://localhost:43821/api/v1/drive/oauth/callback` locally; register this exact URL with Google |
| `GMUSIC_ORIGINAL_FOLDER_ID` | laptop quality worker | Google Drive source folder ID; this project uses the `Music ` folder |
| `GMUSIC_ROOT_FOLDER_ID` | no | parent for the separate `Low`, `Medium`, and `High` output folders; defaults to the original folder |
| `GMUSIC_DRIVE_OWNER_ID` | no | backend Drive owner identity for rendition metadata; defaults to `shared` |
| `GOOGLE_CREDENTIALS_PATH` | laptop quality worker | OAuth client file; defaults to `credentials1.json` in the repository root |
| `GOOGLE_TOKEN_PATH` | no | laptop OAuth token file; defaults to `temp_file_convert_upload_python/token.json` |
| `GOOGLE_OAUTH_LOCAL_PORT` | no | local OAuth callback port; defaults to `8765` |
| `MONGO_URI` and `MONGO_DB` | laptop quality worker | same MongoDB database as the backend; publishes rendition status and Drive file IDs |
| `MAX_WORKERS` and `FFMPEG_THREADS` | no | laptop-only parallel song and FFmpeg worker limits |
| `MAX_CPU_PERCENT` and `MAX_MEM_PERCENT` | no | laptop-only resource thresholds that pause new transcodes |
Do not print or paste OAuth tokens or the encryption key into logs, shell
history, chat, or source control.

For local bridge development, omitting `MONGO_URI` explicitly selects token-only
mode; account login and user-owned persistence are unavailable in that mode.
Production deployments must configure Atlas and should set `REQUIRE_MONGO=true`.
The `/health` response reports `authMode` and `database` so operators can verify
the active mode without exposing connection details.

Quality renditions are generated by `temp_file_convert_upload_python/main.py`
on the user's laptop. It reads source files from the configured Drive folder,
uses `credentials1.json`, and uploads MP3s into separate `Low`, `Medium`, and
`High` folders under the configured root. The worker writes owner-, source-
version-, and quality-scoped records to MongoDB's `quality_renditions`
collection. Render only resolves those records and streams the corresponding
Drive file; it does not run FFmpeg or need object-storage credentials. A quality
request returns 404 when that source version has not been pre-generated. The
laptop must use the same Drive account, Mongo database, and owner ID as the
backend. Original quality continues to use the existing Drive passthrough.

From the repository root, prepare and then run the laptop worker with:

```powershell
python -m venv temp_file_convert_upload_python/venv
temp_file_convert_upload_python/venv/Scripts/python.exe -m pip install -r temp_file_convert_upload_python/requirements.txt
temp_file_convert_upload_python/venv/Scripts/python.exe temp_file_convert_upload_python/main.py --dry-run --limit 5
temp_file_convert_upload_python/venv/Scripts/python.exe temp_file_convert_upload_python/main.py
```

Before the first run, add `http://localhost:8765/` to the web OAuth client's
authorized redirect URIs in Google Cloud. The first run opens Google OAuth
consent and stores the worker token beside the script. Review the dry run
before starting the full library; use `--workers` and `--max-cpu` to tune
laptop load. Use `--force` to regenerate every quality. During a forced
refresh, existing rendition records remain ready and keep their Drive links
until the replacement upload completes. Generated files appear in the three
quality folders under `Music `.

The common Drive's initial index is resumable and processes a bounded metadata
page per `POST /api/v1/drive/sync` call. On an always-on Node deployment, the
backend also starts an automatic sync after startup and continues every minute.
Each run processes up to eight pages; later runs apply incremental Drive
changes. In per-user mode, each connected Drive is synced. On Vercel, functions
do not keep background timers alive, so configure a scheduled caller for
`POST /api/v1/drive/sync` if automatic updates are needed. Audio tags are parsed
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

- `api/index.js` runs with `maxDuration: 60`. The Socket.IO endpoint runs as
  `api/v1/playback/socket.js` with `maxDuration: 300`; WebSockets require
  Fluid Compute and reconnect when the function reaches that limit.
- Stream/art tickets are stateless HMAC-signed and work across serverless
  instances; each ticket expires after eight hours.
- Artwork bytes are cached in MongoDB with a size cap and TTL; no thumbnails
  are generated.
- Set every env var above in Vercel; nothing secret is committed.

## Tests

```bash
npm test    # node --test, runs the bridge suite
```
