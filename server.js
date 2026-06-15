const http  = require('http');
const https = require('https');

// ═══════════════════════════════════════════════════════════════════
//  CONFIGURATION
// ═══════════════════════════════════════════════════════════════════
const CLIENT_ID      = process.env.STRAVA_CLIENT_ID;
const CLIENT_SECRET  = process.env.STRAVA_CLIENT_SECRET;
const COACH_PIN      = process.env.COACH_PIN;
const CAF_PIN        = process.env.CAF_PIN;
const PORT           = process.env.PORT || 3000;
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_KEY;

const ALLOWED_ORIGINS = [
  'https://maxvanoli85.github.io',
  'http://localhost',
  'http://127.0.0.1',
  'null'
];

// ── Keep-alive ──────────────────────────────────────────────────────
const SELF_URL = process.env.RENDER_EXTERNAL_URL || 'https://referee-fitness-backend.onrender.com';
setInterval(() => {
  https.get(SELF_URL, () => {}).on('error', () => {});
}, 10 * 60 * 1000);

// ── Scheduled daily sync ────────────────────────────────────────────────────
// Runs every day at 02:00 Luxembourg time (UTC+1/+2)
function scheduleDailySync() {
  const now = new Date();
  // Target: 02:00 CET (UTC+1) = 01:00 UTC, or CEST (UTC+2) = 00:00 UTC
  // Use 01:00 UTC as a safe middle ground year-round
  const next = new Date();
  next.setUTCHours(1, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1); // push to tomorrow
  const msUntil = next - now;
  console.log(`[cron] next daily sync in ${Math.round(msUntil/60000)} minutes (${next.toISOString()})`);
  setTimeout(async () => {
    await runDailySync();
    scheduleDailySync(); // reschedule for next day
  }, msUntil);
}

async function runDailySync() {
  console.log('[cron] starting daily sync —', new Date().toISOString());
  try {
    const refs = await dbGetAll();
    const connected = refs.filter(r => r.token);
    console.log(`[cron] syncing ${connected.length} connected referees`);
    let success = 0, failed = 0;
    for (const ref of connected) {
      try {
        await syncRefereeActivities(ref);
        success++;
        console.log(`[cron] ✓ ${ref.name}`);
      } catch(e) {
        failed++;
        console.log(`[cron] ✗ ${ref.name}: ${e.message}`);
      }
      // Small delay between referees to respect Strava rate limits
      await new Promise(r => setTimeout(r, 2000));
    }
    console.log(`[cron] daily sync complete — ${success} ok, ${failed} failed`);
  } catch(e) {
    console.log('[cron] daily sync error:', e.message);
  }
}

// Start the scheduler
scheduleDailySync();

// ── Supabase REST helpers ───────────────────────────────────────────
function sbRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url  = new URL(SUPABASE_URL + '/rest/v1' + path);
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method,
      headers: {
        'apikey':        SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type':  'application/json',
        'Prefer':        method === 'POST' ? 'return=representation' : 'return=representation',
      }
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: d ? JSON.parse(d) : null }); }
        catch(e) { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function dbGetAll() {
  const r = await sbRequest('GET', '/referees?select=*&order=created_at.asc');
  return r.body || [];
}

async function dbGetByStravaId(stravaId) {
  const r = await sbRequest('GET', `/referees?strava_id=eq.${stravaId}&select=*`);
  return (r.body && r.body[0]) || null;
}

async function dbGetById(id) {
  const r = await sbRequest('GET', `/referees?id=eq.${encodeURIComponent(id)}&select=*`);
  return (r.body && r.body[0]) || null;
}

async function dbGetByFirstName(firstName) {
  const normalize = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const all = await dbGetAll();
  const fn  = normalize(firstName);
  return all.find(r => normalize(r.name.split(' ')[0]) === fn) || null;
}

async function dbUpsert(id, fields) {
  // PATCH existing row
  const r = await sbRequest('PATCH',
    `/referees?id=eq.${encodeURIComponent(id)}`,
    fields
  );
  if (r.status === 404 || (r.body && Array.isArray(r.body) && r.body.length === 0)) {
    // Row doesn't exist — insert
    await sbRequest('POST', '/referees', { id, name: fields.name || 'Athlete', ...fields });
  }
  return true;
}

async function dbInsert(row) {
  const r = await sbRequest('POST', '/referees', row);
  return r.body;
}

// ── HTTP helpers ────────────────────────────────────────────────────
function setCORS(req, res) {
  const origin  = req.headers.origin || '';
  const allowed = ALLOWED_ORIGINS.some(o => origin.startsWith(o));
  res.setHeader('Access-Control-Allow-Origin',  allowed ? origin : ALLOWED_ORIGINS[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Coach-Pin');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 500000) reject(new Error('Body too large')); });
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function stravaPost(payload) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(payload).toString();
    const opts = {
      hostname: 'www.strava.com', path: '/api/v3/oauth/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

function checkPin(req) {
  return req.headers['x-coach-pin'] === COACH_PIN;
}

async function ensureFreshToken(ref) {
  if (!ref.token) return null;
  const now = Math.floor(Date.now() / 1000);
  if (ref.expires && ref.expires > now + 300) return ref.token;
  if (!ref.refresh) return null;
  try {
    const r = await stravaPost({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: ref.refresh, grant_type: 'refresh_token' });
    if (r.status !== 200) return null;
    const { access_token, refresh_token, expires_at } = r.body;
    await dbUpsert(ref.id, { token: access_token, refresh: refresh_token, expires: expires_at });
    return access_token;
  } catch(e) { return null; }
}

// ── Fetch HR stream and compute exact zone minutes ──────────────────────────
// Polar zone boundaries: Z1<60%, Z2 60-76%, Z3 76-86%, Z4 86-94%, Z5>94%
const ZONE_BOUNDS = [0.60, 0.76, 0.86, 0.94];

function hrToZoneIndex(hr, maxHR) {
  const pct = hr / maxHR;
  if (pct < ZONE_BOUNDS[0]) return 0;
  if (pct < ZONE_BOUNDS[1]) return 1;
  if (pct < ZONE_BOUNDS[2]) return 2;
  if (pct < ZONE_BOUNDS[3]) return 3;
  return 4;
}

function calcZonesFromStream(hrData, timeData, maxHR) {
  // hrData: array of HR values (bpm), timeData: array of elapsed seconds
  // Returns array of 5 values: seconds spent in each zone
  const zones = [0, 0, 0, 0, 0];
  if (!hrData || !timeData || hrData.length < 2) return null;
  for (let i = 1; i < hrData.length; i++) {
    const dt = timeData[i] - timeData[i - 1]; // seconds since last point
    if (dt <= 0 || dt > 60) continue; // skip gaps > 1 min (pauses)
    const hr = hrData[i];
    if (!hr || hr < 30 || hr > 250) continue; // skip invalid readings
    zones[hrToZoneIndex(hr, maxHR)] += dt;
  }
  return zones; // seconds per zone
}

// ── Background stream fetch (called after /referee/push) ───────────────────
async function fetchStreamsInBackground(ref) {
  // Prevent parallel fetches for the same referee
  if (fetchStreamsInBackground._running) {
    if (fetchStreamsInBackground._running[ref.id]) {
      console.log(`[stream] skipping — already running for ${ref.name}`);
      return;
    }
  } else { fetchStreamsInBackground._running = {}; }
  fetchStreamsInBackground._running[ref.id] = true;

  try {
    // Re-read from DB to get fresh token (may have just been saved by /exchange)
    const freshRef = await dbGetById(ref.id);
    const refToUse = (freshRef && freshRef.token) ? freshRef : ref;

    console.log(`[stream] starting for ${refToUse.name}, has token: ${!!refToUse.token}`);
    if (!refToUse.token) { console.log('[stream] no token stored, skipping'); return; }

    const token = await ensureFreshToken(refToUse);
    if (!token) { console.log('[stream] could not refresh token'); return; }

    const now = Math.floor(Date.now() / 1000);
    const cutoff90 = now - 60 * 60 * 24 * 90;
    const profile = refToUse.profile || {};
    const maxHR = profile.maxhr || (profile.age ? 220 - profile.age : 185);

    // Use activities from DB (most up to date, includes preserved hr_zones)
    const activities = freshRef ? (freshRef.activities || []) : (ref.activities || []);
    const toStream = activities.filter(a =>
      a.average_heartrate &&
      !a.hr_zones &&  // skip if already have stream data
      new Date(a.start_date).getTime() / 1000 > cutoff90
    );

    console.log(`[stream] will fetch ${toStream.length} new streams for ${refToUse.name} (${activities.filter(a=>a.hr_zones).length} already cached)`);
    if (!toStream.length) { console.log('[stream] all activities already have hr_zones'); return; }

    let updated = false;
    for (const act of toStream) {
      await new Promise(r => setTimeout(r, 300));
      const stream = await fetchHRStream(act.id, token);
      if (stream) {
        const zones = calcZonesFromStream(stream.hr, stream.time, maxHR);
        if (zones) { act.hr_zones = zones; updated = true; }
      }
    }

    if (updated) {
      await dbUpsert(refToUse.id, { activities });
      const zoneCount = activities.filter(a => a.hr_zones).length;
      console.log(`[stream] complete for ${refToUse.name} — ${zoneCount} activities have hr_zones`);
    }
  } catch(e) {
    console.log('[stream] error:', e.message);
  } finally {
    if (fetchStreamsInBackground._running) delete fetchStreamsInBackground._running[ref.id];
  }
}

async function fetchHRStream(activityId, token) {
  return new Promise((resolve) => {
    const opts = {
      hostname: 'www.strava.com',
      path: `/api/v3/activities/${activityId}/streams?keys=heartrate,time&key_by_type=true`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` }
    };
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(d);
          if (parsed.heartrate && parsed.time) {
            console.log(`[stream] activity ${activityId}: ${parsed.heartrate.data.length} HR points`);
            resolve({ hr: parsed.heartrate.data, time: parsed.time.data });
          } else {
            console.log(`[stream] activity ${activityId}: no HR data (keys: ${Object.keys(parsed).join(',')})`);
            if (parsed.errors) console.log('[stream] Strava error:', JSON.stringify(parsed.errors));
            resolve(null);
          }
        } catch(e) {
          console.log(`[stream] activity ${activityId}: parse error`, e.message);
          resolve(null);
        }
      });
    });
    req.on('error', (e) => {
      console.log(`[stream] activity ${activityId}: request error`, e.message);
      resolve(null);
    });
    req.end();
  });
}

async function syncRefereeActivities(ref) {
  const token = await ensureFreshToken(ref);
  if (!token) return;
  const now   = Math.floor(Date.now() / 1000);
  const after = now - 60 * 60 * 24 * 548; // 18 months
  let all = [], page = 1;
  while (true) {
    const r = await new Promise((resolve, reject) => {
      const opts = {
        hostname: 'www.strava.com',
        path: `/api/v3/athlete/activities?after=${after}&before=${now}&per_page=100&page=${page}`,
        method: 'GET', headers: { Authorization: `Bearer ${token}` }
      };
      const req = https.request(opts, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
      });
      req.on('error', reject); req.end();
    });
    if (!Array.isArray(r) || !r.length) break;
    all = all.concat(r.map(a => ({
      id: a.id, name: a.name, type: a.type, sport_type: a.sport_type,
      start_date: a.start_date, elapsed_time: a.elapsed_time, moving_time: a.moving_time,
      distance: a.distance, average_heartrate: a.average_heartrate, max_heartrate: a.max_heartrate
    })));
    if (r.length < 100) break;
    page++;
  }

  // Fetch HR streams for activities in last 90 days that have HR data
  const cutoff90 = now - 60 * 60 * 24 * 90;
  const profile  = ref.profile || {};
  // Max HR: use stored profile value, or estimate from age, or fallback
  const maxHR    = profile.maxhr || (profile.age ? 220 - profile.age : 185);
  const existing = (ref.activities || []).reduce((m, a) => { m[String(a.id)] = a; return m; }, {});

  const toStream = all.filter(a =>
    a.average_heartrate &&                            // has HR data
    new Date(a.start_date).getTime() / 1000 > cutoff90 // last 90 days
  );

  console.log(`[stream] ${ref.name}: fetching ${toStream.length} new streams (${all.filter(a=>a.hr_zones).length} already cached)`);

  // Rate-limit: Strava allows 100 req/15min. Fetch with small delay.
  for (const act of toStream) {
    const prev = existing[String(act.id)];
    // Skip if we already have stream data for this activity
    if (prev && prev.hr_zones) {
      act.hr_zones = prev.hr_zones;
      continue;
    }
    await new Promise(r => setTimeout(r, 300)); // 300ms between calls
    const stream = await fetchHRStream(act.id, token);
    if (stream) {
      const zones = calcZonesFromStream(stream.hr, stream.time, maxHR);
      if (zones) act.hr_zones = zones; // [s_z1, s_z2, s_z3, s_z4, s_z5]
    }
  }

  // Preserve hr_zones for older activities already in DB
  all.forEach(a => {
    if (!a.hr_zones) {
      const prev = existing[String(a.id)];
      if (prev && prev.hr_zones) a.hr_zones = prev.hr_zones;
    }
  });

  await dbUpsert(ref.id, { activities: all, last_sync: new Date().toISOString() });
  console.log(`[stream] ${ref.name}: sync complete, ${toStream.length} streams processed`);
}

// ── Router ──────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  setCORS(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/') {
    send(res, 200, { status: 'ok', service: 'Referee Fitness backend', storage: 'supabase' }); return;
  }

  // ── /exchange ────────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/exchange') {
    try {
      const { code, refereeId } = await readBody(req);
      if (!code) { send(res, 400, { error: 'Missing code' }); return; }
      const r = await stravaPost({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, grant_type: 'authorization_code' });
      if (r.status !== 200) { send(res, 502, { error: 'Strava exchange failed', detail: r.body }); return; }
      const { access_token, refresh_token, expires_at, athlete } = r.body;
      console.log('[exchange] refereeId:', refereeId, 'athlete:', athlete?.id, athlete?.firstname);
      if (refereeId) {
        let ref = await dbGetById(refereeId);
        console.log('[exchange] found ref by id:', ref?.id, ref?.name);
        if (ref) {
          await dbUpsert(ref.id, { token: access_token, refresh: refresh_token, expires: expires_at, strava_id: athlete?.id });
          console.log('[exchange] token saved for', ref.name);
        } else {
          console.log('[exchange] no ref found for id:', refereeId, '— trying by stravaId');
          // Try to find by stravaId as fallback
          let refByStrava = await dbGetByStravaId(athlete?.id);
          if (refByStrava) {
            await dbUpsert(refByStrava.id, { token: access_token, refresh: refresh_token, expires: expires_at, strava_id: athlete?.id });
            console.log('[exchange] token saved via stravaId for', refByStrava.name);
          } else {
            console.log('[exchange] no ref found at all — creating auto slot');
            const id = 'auto_' + athlete?.id;
            await dbInsert({ id, name: [athlete?.firstname, athlete?.lastname].filter(Boolean).join(' '), strava_id: athlete?.id, token: access_token, refresh: refresh_token, expires: expires_at, activities: [], profile: {}, feedback: {}, monthly_feelings: {}, rpe: {} });
          }
        }
      } else {
        console.log('[exchange] no refereeId — trying to match by stravaId', athlete?.id);
        const normalize = s => (s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();

        // 1. Try by stravaId
        let ref = await dbGetByStravaId(athlete?.id);

        // 2. Try by firstname (accent-insensitive)
        if (!ref && athlete?.firstname) {
          ref = await dbGetByFirstName(athlete.firstname);
          if (ref) console.log('[exchange] matched by firstname:', ref.name);
        }

        // 3. Try by full name match across all refs
        if (!ref && athlete?.firstname) {
          const all = await dbGetAll();
          const stravaFull = normalize((athlete.firstname||'') + ' ' + (athlete.lastname||''));
          const stravaFirst = normalize(athlete.firstname||'');
          const stravaLast  = normalize(athlete.lastname||'');
          ref = all.find(r => {
            const parts = r.name.split(' ').map(normalize);
            const dbFull = normalize(r.name);
            return dbFull === stravaFull
              || parts[0] === stravaFirst
              || (stravaLast && parts[parts.length-1] === stravaLast && parts[0] === stravaFirst);
          }) || null;
          if (ref) console.log('[exchange] matched by full name:', ref.name);
        }

        if (ref) {
          // Check for existing auto slot — migrate its data to the named slot
          const autoId = 'auto_' + athlete?.id;
          const autoSlot = await dbGetById(autoId);
          if (autoSlot && autoSlot.id !== ref.id) {
            console.log('[exchange] merging auto slot into named slot:', ref.name);
            // Merge: named slot keeps its name/level/profile, gets auto slot's data
            const merged = {
              token:            access_token,
              refresh:          refresh_token,
              expires:          expires_at,
              strava_id:        athlete?.id,
              activities:       autoSlot.activities?.length ? autoSlot.activities : ref.activities,
              monthly_feelings: Object.assign({}, autoSlot.monthly_feelings||{}, ref.monthly_feelings||{}),
              rpe:              Object.assign({}, autoSlot.rpe||{}, ref.rpe||{}),
              feedback:         Object.assign({}, autoSlot.feedback||{}, ref.feedback||{}),
            };
            await dbUpsert(ref.id, merged);
            // Delete the auto slot
            await sbRequest('DELETE', `/referees?id=eq.${encodeURIComponent(autoId)}`);
            console.log('[exchange] auto slot merged and deleted');
          } else {
            await dbUpsert(ref.id, { token: access_token, refresh: refresh_token, expires: expires_at, strava_id: athlete?.id });
            console.log('[exchange] token saved for', ref.name);
          }
        } else {
          // No match found — create auto slot with token so sync works
          const autoId = 'auto_' + athlete?.id;
          const existing = await dbGetById(autoId);
          const name = [athlete?.firstname, athlete?.lastname].filter(Boolean).join(' ') || 'Athlete';
          if (existing) {
            await dbUpsert(autoId, { token: access_token, refresh: refresh_token, expires: expires_at });
            console.log('[exchange] updated auto slot token for', name);
          } else {
            await dbInsert({ id: autoId, name, strava_id: athlete?.id, token: access_token, refresh: refresh_token, expires: expires_at, activities: [], profile: {}, feedback: {}, monthly_feelings: {}, rpe: {} });
            console.log('[exchange] created auto slot for', name);
          }
        }
      }
      send(res, 200, { access_token, refresh_token, expires_at, athlete });
    } catch(e) { send(res, 500, { error: e.message }); }
    return;
  }

  // ── /refresh ─────────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/refresh') {
    try {
      const { refresh_token } = await readBody(req);
      if (!refresh_token) { send(res, 400, { error: 'Missing refresh_token' }); return; }
      const r = await stravaPost({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token, grant_type: 'refresh_token' });
      if (r.status !== 200) { send(res, 502, { error: 'Strava refresh failed' }); return; }
      const { access_token, refresh_token: new_refresh, expires_at } = r.body;
      send(res, 200, { access_token, refresh_token: new_refresh, expires_at });
    } catch(e) { send(res, 500, { error: e.message }); }
    return;
  }

  // ── /coach/login ─────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/coach/login') {
    try {
      const { pin } = await readBody(req);
      if (pin === COACH_PIN)     send(res, 200, { ok: true, role: 'coach' });
      else if (pin === CAF_PIN)  send(res, 200, { ok: true, role: 'caf' });
      else                       send(res, 401, { error: 'Wrong PIN' });
    } catch(e) { send(res, 500, { error: e.message }); }
    return;
  }

  // ── /coach/referees ──────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/coach/referees') {
    if (!checkPin(req)) { send(res, 401, { error: 'Unauthorized' }); return; }
    try {
      const rows = await dbGetAll();
      const safe = rows.map(r => {
        // Apply stored _cat overrides from rpe field into activities
        const rpe = r.rpe || {};
        const acts = (r.activities || []).map(a => {
          const rpeVal = rpe[String(a.id)];
          if (rpeVal && typeof rpeVal === 'string' && rpeVal.startsWith('_cat:')) {
            return { ...a, _cat: rpeVal.replace('_cat:', '') };
          }
          return a;
        });
        return {
          id: r.id, name: r.name, connected: !!r.token, strava_id: r.strava_id,
          lastSync: r.last_sync, activities: acts,
          profile: r.profile || null, feedback: r.feedback || {},
          monthlyFeelings: r.monthly_feelings || {}, rpe
        };
      });
      send(res, 200, { referees: safe });
    } catch(e) { send(res, 500, { error: e.message }); }
    return;
  }

  // ── /coach/sync ──────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/coach/sync') {
    if (!checkPin(req)) { send(res, 401, { error: 'Unauthorized' }); return; }
    try {
      const rows = await dbGetAll();
      const connected = rows.filter(r => r.token);
      Promise.all(connected.map(r => syncRefereeActivities(r).catch(() => {}))).catch(() => {});
      send(res, 200, { ok: true, syncing: connected.length });
    } catch(e) { send(res, 500, { error: e.message }); }
    return;
  }

  // ── /coach/add-referee ───────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/coach/add-referee') {
    if (!checkPin(req)) { send(res, 401, { error: 'Unauthorized' }); return; }
    try {
      const { name } = await readBody(req);
      if (!name) { send(res, 400, { error: 'Missing name' }); return; }
      const id = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]/g,'').slice(0,20) + '_' + Date.now();
      await dbInsert({ id, name, activities: [], profile: {}, feedback: {}, monthly_feelings: {}, rpe: {} });
      send(res, 200, { ok: true, id, name });
    } catch(e) { send(res, 500, { error: e.message }); }
    return;
  }

  // ── /coach/remove-referee ────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/coach/remove-referee') {
    if (!checkPin(req)) { send(res, 401, { error: 'Unauthorized' }); return; }
    try {
      const { id } = await readBody(req);
      await sbRequest('DELETE', `/referees?id=eq.${encodeURIComponent(id)}`);
      send(res, 200, { ok: true });
    } catch(e) { send(res, 500, { error: e.message }); }
    return;
  }

  // ── /coach/feedback ──────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/coach/feedback') {
    if (!checkPin(req)) { send(res, 401, { error: 'Unauthorized — wrong PIN' }); return; }
    try {
      const { refereeId, monthKey, feedback } = await readBody(req);
      if (!refereeId || !monthKey) { send(res, 400, { error: 'Missing refereeId or monthKey' }); return; }
      const ref = await dbGetById(refereeId);
      if (!ref) { send(res, 404, { error: 'Referee not found: ' + refereeId }); return; }
      const existing = ref.feedback || {};
      existing[monthKey] = { ...feedback, updatedAt: new Date().toISOString() };
      await dbUpsert(refereeId, { feedback: existing });
      send(res, 200, { ok: true });
    } catch(e) { send(res, 500, { error: e.message }); }
    return;
  }

  // ── /referee/push ────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/referee/push') {
    try {
      const { stravaId, stravaFirstname, stravaLastname, activities, refereeId, profile } = await readBody(req);
      if (!stravaId || !activities) { send(res, 400, { error: 'Missing stravaId or activities' }); return; }
      const normalize = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
      let ref = null;
      if (refereeId)      ref = await dbGetById(refereeId);
      if (!ref)           ref = await dbGetByStravaId(stravaId);
      if (!ref && stravaFirstname) ref = await dbGetByFirstName(stravaFirstname);
      if (!ref) {
        const fullName = [stravaFirstname, stravaLastname].filter(Boolean).join(' ') || 'Athlete';
        const id = 'auto_' + stravaId;
        await dbInsert({ id, name: fullName, strava_id: stravaId, activities: [], profile: {}, feedback: {}, monthly_feelings: {}, rpe: {} });
        ref = { id, name: fullName };
        console.log(`Auto-created slot for ${fullName}`);
      }
      const mergedProfile = Object.assign({}, ref.profile || {},
        Object.fromEntries(Object.entries(profile || {}).filter(([,v]) => v !== null && v !== undefined))
      );
      // Preserve existing hr_zones — don't overwrite with empty frontend data
      const existingActs = (ref.activities || []).reduce((m,a) => { m[String(a.id)]=a; return m; }, {});
      const mergedActs = activities.map(a => {
        const prev = existingActs[String(a.id)];
        return (prev && prev.hr_zones) ? { ...a, hr_zones: prev.hr_zones } : a;
      });

      await dbUpsert(ref.id, {
        strava_id: stravaId,
        activities: mergedActs,
        last_sync: new Date().toISOString(),
        profile: mergedProfile,
        ...(stravaFirstname && ref.id.startsWith('auto_') ? { name: [stravaFirstname, stravaLastname].filter(Boolean).join(' ') } : {})
      });
      // Fetch HR streams for recent activities with HR data (async, don't block response)
      send(res, 200, { ok: true, name: ref.name, count: activities.length });
      // Background stream fetch after responding
      (async () => {
        try {
          const freshRef = await dbGetById(ref.id);
          console.log(`[stream] starting for ${ref.name}, has token: ${!!freshRef?.token}`);
          if (!freshRef || !freshRef.token) { console.log('[stream] no token stored, skipping'); return; }
          const token = await ensureFreshToken(freshRef);
          console.log(`[stream] token refreshed: ${!!token}`);
          if (!token) { console.log('[stream] could not refresh token'); return; }
          const now = Math.floor(Date.now() / 1000);
          const cutoff90 = now - 60 * 60 * 24 * 90;
          const profile = freshRef.profile || {};
          const maxHR = profile.maxhr || (profile.age ? 220 - profile.age : 185);
          const existing = (freshRef.activities || []).reduce((m, a) => { m[String(a.id)] = a; return m; }, {});
          const toStream = (freshRef.activities || []).filter(a =>
            a.average_heartrate && new Date(a.start_date).getTime() / 1000 > cutoff90
          );
          console.log(`[stream] will fetch ${toStream.length} streams for ${freshRef.name}`);
          let updated = false;
          for (const act of toStream) {
            if (act.hr_zones) continue; // already have it
            await new Promise(r => setTimeout(r, 300));
            const stream = await fetchHRStream(act.id, token);
            if (stream) {
              const zones = calcZonesFromStream(stream.hr, stream.time, maxHR);
              if (zones) { act.hr_zones = zones; updated = true; }
            }
          }
          if (updated) {
            await dbUpsert(freshRef.id, { activities: freshRef.activities });
            const zoneCount = freshRef.activities.filter(a=>a.hr_zones).length;
      console.log(`[stream] background fetch complete for ${freshRef.name} — ${zoneCount} activities have hr_zones`);
          }
        } catch(e) { console.log('[stream] background fetch error:', e.message); }
      })();
    } catch(e) { send(res, 500, { error: e.message }); }
    return;
  }

  // ── /referee/rpe ─────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/referee/rpe') {
    try {
      const { stravaId, activityId, rpe, refereeId } = await readBody(req);
      if (!activityId) { send(res, 400, { error: 'Missing activityId' }); return; }
      let ref = null;
      if (refereeId) ref = await dbGetById(refereeId);
      if (!ref && stravaId) ref = await dbGetByStravaId(stravaId);
      if (!ref) { send(res, 404, { error: 'Referee not found' }); return; }
      const existing = ref.rpe || {};
      existing[String(activityId)] = rpe;
      await dbUpsert(ref.id, { rpe: existing });
      send(res, 200, { ok: true });
    } catch(e) { send(res, 500, { error: e.message }); }
    return;
  }

  // ── /referee/weekly-feeling (now monthly) ────────────────────────
  if (req.method === 'POST' && req.url === '/referee/weekly-feeling') {
    try {
      const { stravaId, weekKey, feeling } = await readBody(req);
      if (!stravaId || !weekKey) { send(res, 400, { error: 'Missing fields' }); return; }
      let ref = await dbGetByStravaId(stravaId);
      if (!ref) {
        const id = 'auto_' + stravaId;
        await dbInsert({ id, name: 'Athlete', strava_id: stravaId, activities: [], profile: {}, feedback: {}, monthly_feelings: {}, rpe: {} });
        ref = await dbGetByStravaId(stravaId);
      }
      const existing = ref.monthly_feelings || {};
      existing[weekKey] = feeling;
      await dbUpsert(ref.id, { monthly_feelings: existing });
      send(res, 200, { ok: true });
    } catch(e) { send(res, 500, { error: e.message }); }
    return;
  }

  // ── /referee/feedback ────────────────────────────────────────────
  if (req.method === 'GET' && req.url.startsWith('/referee/feedback')) {
    try {
      const url      = new URL('http://x' + req.url);
      const stravaId = parseInt(url.searchParams.get('stravaId'));
      const monthKey = url.searchParams.get('monthKey');
      if (!stravaId || !monthKey) { send(res, 400, { error: 'Missing params' }); return; }
      const ref = await dbGetByStravaId(stravaId);
      if (!ref) { send(res, 200, { feedback: null }); return; }
      send(res, 200, { feedback: (ref.feedback || {})[monthKey] || null });
    } catch(e) { send(res, 500, { error: e.message }); }
    return;
  }

  // ── /caf/summary ─────────────────────────────────────────────────
  if (req.method === 'GET' && req.url.startsWith('/caf/summary')) {
    const pin = req.headers['x-coach-pin'];
    if (pin !== CAF_PIN && pin !== COACH_PIN) { send(res, 401, { error: 'Unauthorized' }); return; }
    try {
      const rows = await dbGetAll();
      const summary = rows.map(r => {
        const rpe = r.rpe || {};
        const acts = (r.activities || []).map(a => {
          const rpeVal = rpe[String(a.id)];
          if (rpeVal && typeof rpeVal === 'string' && rpeVal.startsWith('_cat:')) {
            return { ...a, _cat: rpeVal.replace('_cat:', '') };
          }
          return a;
        });
        return {
          id: r.id, name: r.name, connected: !!r.token, strava_id: r.strava_id,
          lastSync: r.last_sync, profile: r.profile || null,
          activities: acts, feedback: r.feedback || {},
          monthlyFeelings: r.monthly_feelings || {}, rpe
        };
      });
      send(res, 200, { referees: summary });
    } catch(e) { send(res, 500, { error: e.message }); }
    return;
  }

  // ── /referee/profile (lightweight profile save) ─────────────────────────
  if (req.method === 'POST' && req.url === '/referee/profile') {
    try {
      const { stravaId, profile } = await readBody(req);
      if (!stravaId || !profile) { send(res, 400, { error: 'Missing fields' }); return; }
      let ref = await dbGetByStravaId(stravaId);
      if (!ref && profile && profile.picture) {
        // Try auto-create if not found yet
        const id = 'auto_' + stravaId;
        await dbInsert({ id, name: 'Athlete', strava_id: stravaId, activities: [], profile: {}, feedback: {}, monthly_feelings: {}, rpe: {} });
        ref = await dbGetByStravaId(stravaId);
      }
      if (!ref) { send(res, 404, { error: 'Referee not found — sync activities first' }); return; }
      const merged = Object.assign({}, ref.profile || {},
        Object.fromEntries(Object.entries(profile).filter(([,v]) => v !== null && v !== undefined))
      );
      await dbUpsert(ref.id, { profile: merged });
      console.log(`Profile saved for ${ref.name}`);
      send(res, 200, { ok: true, name: ref.name });
    } catch(e) { send(res, 500, { error: e.message }); }
    return;
  }

  // ── /referee/get-profile ────────────────────────────────────────────────
  if (req.method === 'GET' && req.url.startsWith('/referee/get-profile')) {
    try {
      const url = new URL('http://x' + req.url);
      const stravaId = parseInt(url.searchParams.get('stravaId'));
      if (!stravaId) { send(res, 400, { error: 'Missing stravaId' }); return; }
      const ref = await dbGetByStravaId(stravaId);
      if (!ref) { send(res, 200, { profile: null }); return; }
      send(res, 200, { profile: ref.profile || null });
    } catch(e) { send(res, 500, { error: e.message }); }
    return;
  }

  // ── /referee/activities — returns full activities with hr_zones ────────────
  if (req.method === 'GET' && req.url.startsWith('/referee/activities')) {
    try {
      const url = new URL('http://x' + req.url);
      const stravaId = parseInt(url.searchParams.get('stravaId'));
      if (!stravaId) { send(res, 400, { error: 'Missing stravaId' }); return; }
      const ref = await dbGetByStravaId(stravaId);
      if (!ref) { send(res, 404, { error: 'Not found' }); return; }
      // Apply _cat overrides from rpe field
      const rpe = ref.rpe || {};
      const acts = (ref.activities || []).map(a => {
        const rpeVal = rpe[String(a.id)];
        if (rpeVal && typeof rpeVal === 'string' && rpeVal.startsWith('_cat:')) {
          return { ...a, _cat: rpeVal.replace('_cat:', '') };
        }
        return a;
      });
      const exactCount = acts.filter(a => a.hr_zones && a.hr_zones.length === 5).length;
      console.log(`[activities] ${ref.name}: ${exactCount} exact zones out of ${acts.length}`);
      send(res, 200, { activities: acts, exactZones: exactCount });
    } catch(e) { send(res, 500, { error: e.message }); }
    return;
  }

  send(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('ERROR: SUPABASE_URL and SUPABASE_KEY environment variables are required');
    process.exit(1);
  }
  console.log(`Referee Fitness backend on port ${PORT} — storage: Supabase`);
  console.log(`Keep-alive pinging ${SELF_URL} every 10 minutes`);
});
