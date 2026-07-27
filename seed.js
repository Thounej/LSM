// LSM (Latitude Speedmapping) - seed script
//
// This is adapted from the Illan Cup Medals seed.js. The main difference:
// instead of pulling every campaign in a club, this pulls only the activities
// inside ONE folder (FOLDER_ID) of the club, since that's the "speedmapping
// folder" we care about.
//
// NOTE ON TESTING: this script talks to Nadeo's live API using a Ubisoft
// service account, which only works from a real machine with network access
// to ubisoft/nadeo's servers (not available in the sandbox that generated
// this file). It has NOT been run against the real folder yet. Run it locally
// first with `node seed.js` and watch the console output - it logs every
// activity it finds (name + activityType) so you can see exactly what's in
// the folder. If an activity type shows up that isn't handled below, paste
// me the console output and I'll adjust the parsing.

require('dotenv').config();
const fetch = require('node-fetch');

const {
  TM_SERVICE_LOGIN,
  TM_SERVICE_PASSWORD,
  CLUB_ID,
  FOLDER_ID,
  CF_ACCOUNT_ID,
  CF_API_TOKEN,
  CF_KV_NAMESPACE_ID
} = process.env;

const UBI_APP_ID = '86263886-327a-4328-ac69-527f0d20a237'; // public Trackmania server app id
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Strips Trackmania's in-game text formatting codes so stored names are
// plain text (the frontend also does this defensively, but cleaning it here
// keeps the KV data itself tidy).
function stripTmFormatting(str) {
  if (str == null) return str;
  let s = String(str);
  s = s.replace(/\$\$/g, '\u0001');
  s = s.replace(/\$[lhp]\[[^\]]*\]/gi, '');
  s = s.replace(/\$[lhp]/gi, '');
  s = s.replace(/\$[0-9a-fA-F]{3}/g, '');
  s = s.replace(/\$[a-zA-Z]/g, '');
  s = s.replace(/\u0001/g, '$');
  return s.trim();
}

// ---------------------------------------------------------------------------
// AUTH
// ---------------------------------------------------------------------------

// `service_...` logins are dedicated-server accounts, not real Ubisoft
// player accounts - they have no Ubisoft profile/ticket step at all.
// They authenticate directly against Nadeo with HTTP Basic auth in one call.
// (This is also why the NadeoServices audience 401s for this account type
// but NadeoLiveServices works: it's a permissions difference on the
// server-account side, not an extra auth step.)
async function getNadeoLiveToken() {
  const res = await fetch('https://prod.trackmania.core.nadeo.online/v2/authentication/token/basic', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Basic ' + Buffer.from(`${TM_SERVICE_LOGIN}:${TM_SERVICE_PASSWORD}`).toString('base64'),
      'Ubi-AppId': UBI_APP_ID
    },
    body: JSON.stringify({ audience: 'NadeoLiveServices' })
  });
  if (!res.ok) throw new Error(`Nadeo live token failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.accessToken;
}

async function nadeoGet(baseUrl, path, token) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `nadeo_v1 t=${token}` }
  });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}
const liveGet = (path, token) => nadeoGet('https://live-services.trackmania.nadeo.live', path, token);
const coreGet = (path, token) => nadeoGet('https://prod.trackmania.core.nadeo.online', path, token);

// ---------------------------------------------------------------------------
// STEP 1: find every map inside the folder
// ---------------------------------------------------------------------------

async function getFolderMaps(token) {
  // mapUid -> { seasonUid }   (seasonUid null = use "Personal_Best" leaderboard group)
  const maps = new Map();
  let offset = 0;
  const length = 100;

  while (true) {
    const data = await liveGet(
      `/api/token/club/${CLUB_ID}/activity?length=${length}&offset=${offset}&active=true&folderId=${FOLDER_ID}`,
      token
    );
    const list = data.activityList || [];
    if (list.length === 0) break;

    for (const act of list) {
      console.log(`  activity: "${act.name}" type=${act.activityType} id=${act.activityId}`);

      if (act.activityType === 'campaign' && act.campaignId) {
        const camp = await liveGet(`/api/token/club/${CLUB_ID}/campaign/${act.campaignId}`, token);
        const seasonUid = camp.campaign?.seasonUid || null;
        for (const m of camp.campaign?.playlist || []) {
          maps.set(m.mapUid, { seasonUid });
        }
      } else if (act.activityType === 'room') {
        const room = await liveGet(`/api/token/club/${CLUB_ID}/room/${act.activityId}`, token);
        for (const mapUid of room.room?.maps || []) {
          if (!maps.has(mapUid)) maps.set(mapUid, { seasonUid: null });
        }
      } else {
        // Most speedmapping folders are plain map uploads ("bucket" activities).
        try {
          const bucket = await liveGet(
            `/api/token/club/${CLUB_ID}/bucket/${act.activityId}?length=100&offset=0`,
            token
          );
          if (bucket.type === 'map-upload') {
            for (const item of bucket.bucketItemList || []) {
              if (!maps.has(item.itemId)) maps.set(item.itemId, { seasonUid: null });
            }
          } else {
            console.log(`    (skipping non-map bucket type: ${bucket.type})`);
          }
        } catch (e) {
          console.warn(`    couldn't read activity ${act.activityId} as a bucket: ${e.message}`);
        }
      }
    }

    offset += length;
    if (list.length < length) break;
  }

  return maps;
}

// ---------------------------------------------------------------------------
// STEP 2: map metadata (name, author, times) from the Core API
// ---------------------------------------------------------------------------

async function getMapInfos(mapUids, token) {
  const results = [];
  for (let i = 0; i < mapUids.length; i += 100) {
    const batch = mapUids.slice(i, i + 100);
    const data = await liveGet(`/api/token/map/get-multiple?mapUidList=${batch.join(',')}`, token);
    results.push(...(data.mapList || []));
  }
  return results;
}

// ---------------------------------------------------------------------------
// STEP 3: display names via trackmania.io (rate limited to 1.6s/call)
// ---------------------------------------------------------------------------

async function resolveDisplayName(accountId) {
  try {
    const res = await fetch(`https://trackmania.io/api/player/${accountId}`, {
      headers: { 'User-Agent': 'lsm-medals-seed' }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.displayname || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// STEP 4: AT holders per map (top 100, early-stop once score > authorTime)
// ---------------------------------------------------------------------------

async function getAtHolders(mapUid, groupUid, authorTime, token) {
  const holders = [];
  let offset = 0;
  while (true) {
    const data = await liveGet(
      `/api/token/leaderboard/group/${groupUid}/map/${mapUid}/top?onlyWorld=true&length=100&offset=${offset}`,
      token
    );
    const top = data.tops?.[0]?.top || [];
    if (top.length === 0) break;

    let hitNonAt = false;
    for (const entry of top) {
      if (entry.score <= authorTime) {
        holders.push(entry.accountId);
      } else {
        hitNonAt = true;
        break; // leaderboard is sorted best->worst, stop here
      }
    }
    if (hitNonAt || top.length < 100) break;
    offset += 100;
  }
  return holders;
}

// ---------------------------------------------------------------------------
// STEP 5: Cloudflare KV
// ---------------------------------------------------------------------------

async function kvPut(key, value) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${CF_API_TOKEN}`,
      'Content-Type': 'text/plain'
    },
    body: typeof value === 'string' ? value : JSON.stringify(value)
  });
  if (!res.ok) throw new Error(`KV put ${key} failed: ${res.status} ${await res.text()}`);
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

function checkEnv() {
  const required = ['TM_SERVICE_LOGIN', 'TM_SERVICE_PASSWORD', 'CLUB_ID', 'FOLDER_ID', 'CF_ACCOUNT_ID', 'CF_API_TOKEN', 'CF_KV_NAMESPACE_ID'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`Missing env vars: ${missing.join(', ')}`);
    console.error(`Make sure a file named exactly ".env" (not ".env.example") exists in this folder and is filled in.`);
    process.exit(1);
  }
}

async function main() {
  checkEnv();
  console.log(`Seeding LSM medals for club ${CLUB_ID}, folder ${FOLDER_ID}...`);

  const token = await getNadeoLiveToken();
  console.log('Authenticated.');

  console.log('Scanning folder for maps...');
  const folderMaps = await getFolderMaps(token);
  console.log(`Found ${folderMaps.size} maps in the folder.`);
  if (folderMaps.size === 0) {
    console.error('No maps found - check FOLDER_ID / CLUB_ID and re-read the activity log above.');
    return;
  }

  console.log('Fetching map metadata...');
  const mapInfos = await getMapInfos([...folderMaps.keys()], token);

  console.log('Resolving author display names + scanning leaderboards for AT holders...');
  const authorNameCache = new Map();
  const atCountByPlayer = new Map(); // accountId -> { count, name }
  const maps = [];

  for (const info of mapInfos) {
    const mapUid = info.uid;
    const { name, author, authorTime: authorScore, goldTime: goldScore, silverTime: silverScore, bronzeTime: bronzeScore, thumbnailUrl } = info;
    const { seasonUid } = folderMaps.get(mapUid) || {};
    const groupUid = seasonUid || 'Personal_Best';

    let authorName = authorNameCache.get(author);
    if (authorName === undefined) {
      authorName = await resolveDisplayName(author);
      authorNameCache.set(author, authorName);
      await sleep(1600);
    }

    let atHolders = [];
    try {
      atHolders = await getAtHolders(mapUid, groupUid, authorScore, token);
    } catch (e) {
      console.warn(`  leaderboard scan failed for ${name} (${mapUid}): ${e.message}`);
    }

    for (const accountId of atHolders) {
      const entry = atCountByPlayer.get(accountId) || { count: 0, name: null };
      entry.count += 1;
      atCountByPlayer.set(accountId, entry);
    }

    maps.push({
      mapUid,
      name: stripTmFormatting(name),
      author,
      authorName: stripTmFormatting(authorName || author),
      authorScore,
      goldScore,
      silverScore,
      bronzeScore,
      thumbnailUrl,
      atCount: atHolders.length
    });

    console.log(`  ${name}: ${atHolders.length} AT holder(s)`);
  }

  console.log('Resolving top 100 leaderboard player names...');
  const leaderboard = [...atCountByPlayer.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 100);

  for (const [accountId, entry] of leaderboard) {
    let name = authorNameCache.get(accountId);
    if (name === undefined) {
      name = await resolveDisplayName(accountId);
      await sleep(1600);
    }
    entry.name = stripTmFormatting(name) || accountId;
  }

  const leaderboardOut = leaderboard.map(([accountId, entry]) => ({
    accountId,
    name: entry.name,
    atCount: entry.count
  }));

  console.log('Writing to Cloudflare KV...');
  await kvPut('maps', JSON.stringify(maps));
  await kvPut('leaderboard', JSON.stringify(leaderboardOut));
  await kvPut('lastUpdated', new Date().toISOString());

  console.log(`Done. ${maps.length} maps, ${leaderboardOut.length} leaderboard entries.`);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
