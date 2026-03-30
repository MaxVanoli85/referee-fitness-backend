const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const CLIENT_ID     = '216504';
const CLIENT_SECRET = '49a68dd36016ce760b6d5d3b69173c0f8ae41d5d';
const COACH_PIN     = '8185';
const CAF_PIN       = '5577';
const PORT          = process.env.PORT || 3000;
const DATA_FILE     = path.join('/tmp', 'referee_data.json');

const ALLOWED_ORIGINS = [
  'https://maxvanoli85.github.io',
  'http://localhost',
  'http://127.0.0.1',
  'null'
];

// ── Keep-alive ───────────────────────────────────────────────────────────────
const SELF_URL = process.env.RENDER_EXTERNAL_URL || 'https://referee-fitness-backend.onrender.com';
setInterval(() => {
  https.get(SELF_URL, () => {}).on('error', () => {});
}, 10 * 60 * 1000);

// ── Data store ───────────────────────────────────────────────────────────────
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch(e) {}
  return {
    referees: [
      { id: 'yann_ludovicy', name: 'Yann Ludovicy', token: null, refresh: null, expires: null, lastSync: null, activities: [] },
    ]
  };
}

function saveData(data) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); } catch(e) {}
}

let DB = loadData();

// ── Helpers ──────────────────────────────────────────────────────────────────
function setCORS(req, res) {
  const origin = req.headers.origin || '';
  const allowed = ALLOWED_ORIGINS.some(o => origin.startsWith(o));
  res.setHeader('Access-Control-Allow-Origin', allowed ? origin : ALLOWED_ORIGINS[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Coach-Pin');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 100000) reject(new Error('Body too large')); });
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
    const options = {
      hostname: 'www.strava.com', path: '/api/v3/oauth/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

function stravaGet(token, path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'www.strava.com', path, method: 'GET',
      headers: { Authorization: `Bearer ${token}` }
    };
    const req = https.request(options, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.end();
  });
}

async function ensureFreshToken(referee) {
  if (!referee.token) return null;
  const now = Math.floor(Date.now() / 1000);
  if (referee.expires && referee.expires > now + 300) return referee.token;
  if (!referee.refresh) return null;
  try {
    const result = await stravaPost({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: referee.refresh, grant_type: 'refresh_token' });
    if (result.status !== 200) return null;
    referee.token   = result.body.access_token;
    referee.refresh = result.body.refresh_token;
    referee.expires = result.body.expires_at;
    saveData(DB);
    return referee.token;
  } catch(e) { return null; }
}

async function syncRefereeActivities(referee) {
  const token = await ensureFreshToken(referee);
  if (!token) return;
  const now   = Math.floor(Date.now() / 1000);
  const after = now - 60 * 60 * 24 * 180;
  let all = [], page = 1;
  while (true) {
    const r = await stravaGet(token, `/api/v3/athlete/activities?after=${after}&before=${now}&per_page=100&page=${page}`);
    if (r.status !== 200 || !r.body.length) break;
    all = all.concat(r.body);
    if (r.body.length < 100) break;
    page++;
  }
  referee.activities = all.map(a => ({
    id: a.id, name: a.name, type: a.type, sport_type: a.sport_type,
    start_date: a.start_date, elapsed_time: a.elapsed_time, moving_time: a.moving_time,
    distance: a.distance, average_heartrate: a.average_heartrate, max_heartrate: a.max_heartrate
  }));
  referee.lastSync = new Date().toISOString();
  saveData(DB);
}

function checkPin(req) {
  return req.headers['x-coach-pin'] === COACH_PIN;
}

// ── Router ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  setCORS(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Health
  if (req.method === 'GET' && req.url === '/') {
    send(res, 200, { status: 'ok', service: 'Referee Fitness backend' }); return;
  }

  // ── Referee: exchange code ───────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/exchange') {
    try {
      const { code, refereeId } = await readBody(req);
      if (!code) { send(res, 400, { error: 'Missing code' }); return; }
      const result = await stravaPost({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, grant_type: 'authorization_code' });
      if (result.status !== 200) { send(res, 502, { error: 'Strava exchange failed', detail: result.body }); return; }
      const { access_token, refresh_token, expires_at, athlete } = result.body;

      // If refereeId provided, store tokens server-side
      if (refereeId) {
        const ref = DB.referees.find(r => r.id === refereeId);
        if (ref) {
          ref.token   = access_token;
          ref.refresh = refresh_token;
          ref.expires = expires_at;
          ref.stravaId = athlete?.id;
          if (athlete) ref.name = athlete.firstname + (athlete.lastname ? ' ' + athlete.lastname[0] + '.' : '');
          saveData(DB);
          // Sync in background
          syncRefereeActivities(ref).catch(() => {});
        }
      }
      send(res, 200, { access_token, refresh_token, expires_at, athlete });
    } catch(e) { send(res, 500, { error: e.message }); }
    return;
  }

  // ── Referee: refresh token ───────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/refresh') {
    try {
      const { refresh_token } = await readBody(req);
      if (!refresh_token) { send(res, 400, { error: 'Missing refresh_token' }); return; }
      const result = await stravaPost({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token, grant_type: 'refresh_token' });
      if (result.status !== 200) { send(res, 502, { error: 'Strava refresh failed' }); return; }
      const { access_token, refresh_token: new_refresh, expires_at } = result.body;
      send(res, 200, { access_token, refresh_token: new_refresh, expires_at });
    } catch(e) { send(res, 500, { error: e.message }); }
    return;
  }

  // ── Coach: verify PIN ────────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/coach/login') {
    try {
      const { pin } = await readBody(req);
      if (pin === COACH_PIN) { send(res, 200, { ok: true, role: 'coach' }); }
      else if (pin === CAF_PIN) { send(res, 200, { ok: true, role: 'caf' }); }
      else { send(res, 401, { error: 'Wrong PIN' }); }
    } catch(e) { send(res, 500, { error: e.message }); }
    return;
  }

  // ── Coach: get all referees ──────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/coach/referees') {
    if (!checkPin(req)) { send(res, 401, { error: 'Unauthorized' }); return; }
    const safe = DB.referees.map(r => ({
      id: r.id, name: r.name, connected: !!r.token,
      lastSync: r.lastSync, activities: r.activities || [],
      profile: r.profile || null,
      feedback: r.feedback || {},
      weeklyFeelings: r.weeklyFeelings || {},
      rpe: r.rpe || {},
    }));
    send(res, 200, { referees: safe });
    return;
  }

  // ── Coach: sync all referees ─────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/coach/sync') {
    if (!checkPin(req)) { send(res, 401, { error: 'Unauthorized' }); return; }
    const connected = DB.referees.filter(r => r.token);
    Promise.all(connected.map(r => syncRefereeActivities(r).catch(() => {}))).catch(() => {});
    send(res, 200, { ok: true, syncing: connected.length });
    return;
  }

  // ── Coach: add referee ───────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/coach/add-referee') {
    if (!checkPin(req)) { send(res, 401, { error: 'Unauthorized' }); return; }
    try {
      const { name } = await readBody(req);
      if (!name) { send(res, 400, { error: 'Missing name' }); return; }
      const id = name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) + '_' + Date.now();
      DB.referees.push({ id, name, token: null, refresh: null, expires: null, lastSync: null, activities: [] });
      saveData(DB);
      send(res, 200, { ok: true, id, name });
    } catch(e) { send(res, 500, { error: e.message }); }
    return;
  }

  // ── Coach: remove referee ────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/coach/remove-referee') {
    if (!checkPin(req)) { send(res, 401, { error: 'Unauthorized' }); return; }
    try {
      const { id } = await readBody(req);
      DB.referees = DB.referees.filter(r => r.id !== id);
      saveData(DB);
      send(res, 200, { ok: true });
    } catch(e) { send(res, 500, { error: e.message }); }
    return;
  }

  // ── Referee: push activities ────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/referee/push') {
    try {
      const { stravaId, stravaFirstname, stravaLastname, activities, refereeId, profile } = await readBody(req);
      if (!stravaId || !activities) { send(res, 400, { error: 'Missing stravaId or activities' }); return; }

      let ref = null;

      // 1. Match by refereeId from invite link (most reliable)
      if (refereeId) {
        ref = DB.referees.find(r => r.id === refereeId);
      }

      // 2. Match by Strava ID (returning user)
      if (!ref) {
        ref = DB.referees.find(r => r.stravaId === stravaId);
      }

      // 3. Match by first name (case-insensitive, accent-insensitive)
      if (!ref && stravaFirstname) {
        const normalize = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
        const fn = normalize(stravaFirstname);
        ref = DB.referees.find(r => normalize(r.name.split(' ')[0]) === fn);
      }

      // 4. Create a new slot automatically if no match found
      if (!ref) {
        const fullName = [stravaFirstname, stravaLastname].filter(Boolean).join(' ') || 'Unknown';
        const id = 'auto_' + stravaId;
        ref = { id, name: fullName, token: null, refresh: null, expires: null, lastSync: null, activities: [] };
        DB.referees.push(ref);
        console.log(`Auto-created referee slot for ${fullName} (Strava ID: ${stravaId})`);
      }

      ref.stravaId   = stravaId;
      ref.activities = activities;
      ref.lastSync   = new Date().toISOString();
      if (profile) {
        // Merge incoming profile with existing — don't wipe fields not included this push
        ref.profile = Object.assign({}, ref.profile || {}, 
          Object.fromEntries(Object.entries(profile).filter(([,v]) => v !== null && v !== undefined))
        );
      }
      if (stravaFirstname && ref.id.startsWith('auto_')) {
        ref.name = [stravaFirstname, stravaLastname].filter(Boolean).join(' ');
      }
      saveData(DB);
      console.log(`Saved ${activities.length} activities for ${ref.name}`);
      send(res, 200, { ok: true, name: ref.name, count: activities.length });
    } catch(e) {
      send(res, 500, { error: e.message });
    }
    return;
  }

  // ── Referee: save RPE for activity ──────────────────────────────────────
  if (req.method === 'POST' && req.url === '/referee/rpe') {
    try {
      const { stravaId, activityId, rpe } = await readBody(req);
      if (!stravaId || !activityId) { send(res, 400, { error: 'Missing fields' }); return; }
      const ref = DB.referees.find(r => r.stravaId === stravaId);
      if (!ref) { send(res, 404, { error: 'Referee not found' }); return; }
      if (!ref.rpe) ref.rpe = {};
      ref.rpe[String(activityId)] = rpe;
      saveData(DB);
      send(res, 200, { ok: true });
    } catch(e) { send(res, 500, { error: e.message }); }
    return;
  }

  // ── Referee: save weekly feeling ─────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/referee/weekly-feeling') {
    try {
      const { stravaId, weekKey, feeling } = await readBody(req);
      if (!stravaId || !weekKey) { send(res, 400, { error: 'Missing fields' }); return; }
      const ref = DB.referees.find(r => r.stravaId === stravaId);
      if (!ref) { send(res, 404, { error: 'Referee not found' }); return; }
      if (!ref.weeklyFeelings) ref.weeklyFeelings = {};
      ref.weeklyFeelings[weekKey] = feeling;
      saveData(DB);
      send(res, 200, { ok: true });
    } catch(e) { send(res, 500, { error: e.message }); }
    return;
  }

  // ── Coach: save feedback for referee ─────────────────────────────────────
  if (req.method === 'POST' && req.url === '/coach/feedback') {
    if (!checkPin(req)) { send(res, 401, { error: 'Unauthorized — wrong PIN' }); return; }
    try {
      const { refereeId, monthKey, feedback } = await readBody(req);
      console.log('[feedback] refereeId='+refereeId+' monthKey='+monthKey);
      if (!refereeId || !monthKey) { send(res, 400, { error: 'Missing refereeId or monthKey' }); return; }
      const ref = DB.referees.find(r => r.id === refereeId);
      console.log('[feedback] referees in DB:', DB.referees.map(r=>r.id));
      if (!ref) { send(res, 404, { error: 'Referee not found: ' + refereeId }); return; }
      if (!ref.feedback) ref.feedback = {};
      ref.feedback[monthKey] = { ...feedback, updatedAt: new Date().toISOString() };
      saveData(DB);
      send(res, 200, { ok: true });
    } catch(e) { send(res, 500, { error: e.message }); }
    return;
  }

  // ── CAF: get squad summary ────────────────────────────────────────────────
  if (req.method === 'GET' && req.url.startsWith('/caf/summary')) {
    const pin = req.headers['x-coach-pin'];
    if (pin !== CAF_PIN && pin !== COACH_PIN) { send(res, 401, { error: 'Unauthorized' }); return; }
    const summary = DB.referees.map(r => ({
      id: r.id, name: r.name, connected: !!r.token,
      lastSync: r.lastSync, profile: r.profile || null,
      activities: r.activities || [],
      feedback: r.feedback || {},
      weeklyFeelings: r.weeklyFeelings || {},
      rpe: r.rpe || {},
    }));
    send(res, 200, { referees: summary });
    return;
  }

  send(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`Referee Fitness backend running on port ${PORT}`);
  console.log(`Keep-alive pinging ${SELF_URL} every 10 minutes`);
});
