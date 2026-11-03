# weBLEEDfpv Season 5 Standings

Team standings for the weBLEEDfpv Velocidrone league: each team's combined time on the current track, with one tab per track.

## How it works

- **Backend** (`src/`, a Cloudflare Worker):
  - An hourly timer (`0 * * * *` UTC) fetches the Velocidrone leaderboard for each live track and saves it in Workers KV.
  - When a track reaches its `locksAt` time, the next run saves its final standings and marks it locked. A locked track is never fetched again.
  - If that run happens more than 10 minutes late, the lock uses the last times saved *before* the deadline, so late times never count.
  - Locked tracks keep a frozen copy of the roster and standings, so later roster fixes don't change past results.
  - Every hourly run also adds a small snapshot to that track's history, for charts later.
- **Page** (`public/`, static files): reads only from `/api`. It never contacts Velocidrone.

The page shows a tab for every track in `src/config.js`. Tracks with no leaderboard link are grayed out.

## API

| Route | What it returns |
| --- | --- |
| `GET /api/tracks` | Every track with its status: `upcoming`, `live`, `locking` or `locked` |
| `GET /api/tracks/:id` | One track's standings, with update and lock times |
| `GET /api/tracks/:id/history` | That track's hourly snapshots |
| `POST /api/admin/tracks/:id/refresh` | Fetch a live track now. Needs `Authorization: Bearer <ADMIN_TOKEN>` |
| `POST /api/admin/tracks/:id/lock` | Lock a live track now. Same token |

The admin routes stay off until an `ADMIN_TOKEN` secret is set on the Worker.

## Common changes (all in `src/config.js`)

- **Open the next track:** add its `leaderboardUrl` and `locksAt` to its entry in `TRACKS`.
- **Add a track 7+:** append `{ id: 7, name: "Track 7" }`.
- **Change a lock time:** edit `locksAt`. It's a UTC time; Eastern is UTC−5 in winter. Keep it on the hour so the hourly timer lands on it.
- **Fix a pilot's name:** edit `TEAMS`. Live tracks pick it up on the next page load; locked tracks don't change.
- **Pilot uses a different name on Velocidrone:** add it to `ALIASES`.
- **Roster change for one track only:** give that track its own `teams` list.

## Deploying

`wrangler.jsonc` deploys to a **test** Worker (`webleed-standings-test`), separate from the live page (`webleed-s5-leaderboard`). Switch the `name` only when the test version is approved to replace the live one.

Cloudflare builds and deploys on every push to `main` once the repo is connected: **Workers & Pages → Create application → Import a repository**.

## Development

```
npm install
npm test                         # backend tests (no network)
npm run dev                      # local Worker; trigger the timer with /__scheduled
```
