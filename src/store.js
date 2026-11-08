// Saved data, one entry per track, in Workers KV.
//
//   track:<id>    the latest record for a track (see README for its shape)
//   history:<id>  hourly snapshots for that track, oldest first
//   events:<id>   every first time and new personal best seen on that track, oldest first

const HISTORY_LIMIT = 600; // about 25 days of hourly snapshots per track

export const getRecord = (env, id) => env.STANDINGS.get(`track:${id}`, "json");
export const putRecord = (env, id, record) => env.STANDINGS.put(`track:${id}`, JSON.stringify(record));

export const getHistory = async (env, id) => (await env.STANDINGS.get(`history:${id}`, "json")) || [];

const EVENTS_LIMIT = 6000;
export const getEvents = async (env, id) => (await env.STANDINGS.get(`events:${id}`, "json")) || [];
export async function appendEvents(env, id, events) {
  if (!events.length) return;
  const list = await getEvents(env, id);
  list.push(...events);
  await env.STANDINGS.put(`events:${id}`, JSON.stringify(list.slice(-EVENTS_LIMIT)));
}

export async function appendHistory(env, id, entry) {
  const list = await getHistory(env, id);
  list.push(entry);
  await env.STANDINGS.put(`history:${id}`, JSON.stringify(list.slice(-HISTORY_LIMIT)));
}
