# weBLEEDfpv Season 5 Standings

Team standings for the weBLEEDfpv Velocidrone league: each team's combined time on the current track, with one tab per track.

## How it works

- **Backend** (`src/`, a Cloudflare Worker):
  - A timer every 5 minutes (`*/5 * * * *`) fetches the Velocidrone leaderboard for each live track and saves it in Workers KV. History keeps one snapshot an hour.
  - Saturdays at 11:59 PM Eastern (`59 4 * * SUN` UTC) the lock run happens; an extra refresh at 11:58 PM (`58 4 * * SUN`) is the last one before it. Any track whose `locksAt` has arrived gets its final standings saved and is marked locked. A locked track is never fetched again.
  - Only the lock run fetches final times, and only within 60 seconds of the deadline. Otherwise it locks with the last times saved before the deadline, so late times never count.
  - After the deadline, page visits never fetch. Until the lock is saved they show the last saved times; if the lock run never happens, the first visit 30+ minutes later locks the track from saved data.
  - A refresh still running when the lock lands is discarded, so it can't undo a lock.
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
- **Change a lock time:** edit `locksAt`. It's a UTC time; Eastern is UTC−5 in winter, so Saturday 11:59 PM Eastern is `…T04:59:00Z` on the Sunday. A lock time needs a timer that lands on it: Saturdays 11:59 PM Eastern and every hour on the hour are set up in `wrangler.jsonc`. Cloudflare numbers weekdays 1–7 with Sunday = 1, so write day names (`SUN`) in timers.
- **Fix a pilot's name:** edit `TEAMS`. Live tracks pick it up on the next page load; locked tracks don't change.
- **Pilot uses a different name on Velocidrone:** add it to `ALIASES`.
- **Roster change for one track only:** give that track its own `teams` list.

## Deploying

Every push to `main` deploys to the **live** Worker, `webleed-s5-leaderboard` (connected under the Worker's **Settings → Build**). Check changes with `npm test` and the test preview before pushing to `main`.

`/data` is kept for the original single-track page, so any tab left open from before the switch keeps updating until it's reloaded.

## Development

```
npm install
npm test                         # backend tests (no network)
npm run dev                      # local Worker; trigger the timer with /__scheduled
```
