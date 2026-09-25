// LSM (Latitude Speedmapping) Cloudflare Worker
//
// Same rules as the Illan Cup worker: this worker NEVER rebuilds map data
// from Nadeo. It only serves whatever seed.js already saved into KV, plus a
// few small live-lookup endpoints (top100 for player-scanning, name
// resolution, name search) that don't touch the maps/leaderboard KV keys.
//
// KV binding name used below: LSM

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      if (url.pathname === '/api/maps') {
        const data = await env.LSM.get('maps');
        return json(data ? JSON.parse(data) : []);
      }

      if (url.pathname === '/api/leaderboard') {
        const data = await env.LSM.get('leaderboard');
        return json(data ? JSON.parse(data) : []);
      }

      if (url.pathname === '/api/wrleaderboard') {
        const data = await env.LSM.get('wrLeaderboard');
        return json(data ? JSON.parse(data) : []);
      }

      if (url.pathname === '/api/playerats') {
        const id = url.searchParams.get('id');
        if (!id) return json({ error: 'id required' }, 400);
        const data = await env.LSM.get('playerAts');
        const all = data ? JSON.parse(data) : null;
        if (!all) return json({ id, mapUids: [], seeded: false });
        return json({ id, mapUids: all[id] || [], seeded: true });
      }

      if (url.pathname === '/api/status') {
        const lastUpdated = await env.LSM.get('lastUpdated');
        return json({ lastUpdated });
      }

      if (url.pathname === '/api/top100') {
        const seasonUid = url.searchParams.get('seasonUid') || 'Personal_Best';
        const mapUid = url.searchParams.get('mapUid');
        if (!mapUid) return json({ error: 'mapUid required' }, 400);

        const token = await getNadeoLiveToken(env);
        const res = await fetch(
          `https://live-services.trackmania.nadeo.live/api/token/leaderboard/group/${seasonUid}/map/${mapUid}/top?onlyWorld=true&length=100&offset=0`,
          { headers: { Authorization: `nadeo_v1 t=${token}` } }
        );
        const data = await res.json();
        return json(data);
      }

      if (url.pathname === '/api/resolvename') {
        const id = url.searchParams.get('id');
        if (!id) return json({ error: 'id required' }, 400);

        const cacheKey = `name:${id}`;
        const cached = await env.LSM.get(cacheKey);
        if (cached) return json({ id, displayname: cached });

        const res = await fetch(`https://trackmania.io/api/player/${id}`, {
          headers: { 'User-Agent': 'lsm-medals-worker' }
        });
        if (!res.ok) return json({ id, displayname: null });
        const data = await res.json();
        if (data.displayname) {
          await env.LSM.put(cacheKey, data.displayname, { expirationTtl: 60 * 60 * 24 * 30 });
        }
        return json({ id, displayname: data.displayname || null });
      }

      if (url.pathname === '/api/search') {
        const q = url.searchParams.get('q');
        if (!q) return json({ error: 'q required' }, 400);
        const res = await fetch(`https://trackmania.io/api/players/find?search=${encodeURIComponent(q)}`, {
          headers: { 'User-Agent': 'lsm-medals-worker' }
        });
        const data = await res.json();
        return json(data);
      }

      return json({ error: 'not found' }, 404);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }
};

// Only needed for /api/top100 (live player-scan lookups). Reuses the same
// Ubisoft service account as seed.js - store the same TM_SERVICE_LOGIN /
// TM_SERVICE_PASSWORD as Worker secrets (wrangler secret put).
async function getNadeoLiveToken(env) {
  const cacheKey = 'nadeo_live_token';
  const cached = await env.LSM.get(cacheKey);
  if (cached) return cached;

  // service_... is a dedicated-server account: one-step Basic auth directly
  // against Nadeo, no Ubisoft ticket exchange (see seed.js for the longer
  // explanation).
  const UBI_APP_ID = '86263886-327a-4328-ac69-527f0d20a237';
  const tokenRes = await fetch('https://prod.trackmania.core.nadeo.online/v2/authentication/token/basic', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Basic ' + btoa(`${env.TM_SERVICE_LOGIN}:${env.TM_SERVICE_PASSWORD}`),
      'Ubi-AppId': UBI_APP_ID
    },
    body: JSON.stringify({ audience: 'NadeoLiveServices' })
  });
  const tokenData = await tokenRes.json();

  // Nadeo tokens are valid ~1hr; cache for 50 minutes to be safe.
  await env.LSM.put(cacheKey, tokenData.accessToken, { expirationTtl: 60 * 50 });
  return tokenData.accessToken;
}
