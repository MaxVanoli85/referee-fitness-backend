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

async function syncRefereeActivities(ref) {
  const token = await ensureFreshToken(ref);
  if (!token) return;
  const now   = Math.floor(Date.now() / 1000);
  const after = now - 60 * 60 * 24 * 548;
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
  await dbUpsert(ref.id, { activities: all, last_sync: new Date().toISOString() });
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
      if (refereeId) {
        let ref = await dbGetById(refereeId);
        if (ref) {
          await dbUpsert(ref.id, { token: access_token, refresh: refresh_token, expires: expires_at, strava_id: athlete?.id });
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
      await dbUpsert(ref.id, {
        strava_id: stravaId,
        activities,
        last_sync: new Date().toISOString(),
        profile: mergedProfile,
        ...(stravaFirstname && ref.id.startsWith('auto_') ? { name: [stravaFirstname, stravaLastname].filter(Boolean).join(' ') } : {})
      });
      console.log(`Saved ${activities.length} activities for ${ref.name}`);
      send(res, 200, { ok: true, name: ref.name, count: activities.length });
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
      if (!ref) { send(res, 404, { error: 'Referee not found — connect Strava first' }); return; }
      const merged = Object.assign({}, ref.profile || {},
        Object.fromEntries(Object.entries(profile).filter(([,v]) => v !== null && v !== undefined))
      );
      await dbUpsert(ref.id, { profile: merged });
      console.log(`Profile saved for ${ref.name}`);
      send(res, 200, { ok: true, name: ref.name });
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
