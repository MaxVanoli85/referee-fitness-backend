const http = require('http');
const https = require('https');

// ═══════════════════════════════════════════════════════════
//  CONFIGURATION  —  your Strava credentials
// ═══════════════════════════════════════════════════════════
const CLIENT_ID     = '216504';
const CLIENT_SECRET = '49a68dd36016ce760b6d5d3b69173c0f8ae41d5d';
// ═══════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;

// Allow requests from your GitHub Pages site and localhost for testing
const ALLOWED_ORIGINS = [
  'https://yourusername.github.io',   // ← replace with your actual GitHub Pages URL
  'http://localhost',
  'http://127.0.0.1',
  'null'  // file:// during local testing
];

function setCORS(req, res) {
  const origin = req.headers.origin || '';
  const allowed = ALLOWED_ORIGINS.some(o => origin.startsWith(o));
  res.setHeader('Access-Control-Allow-Origin', allowed ? origin : ALLOWED_ORIGINS[0]);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 10000) reject(new Error('Body too large')); });
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

function stravaPost(path, payload) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(payload).toString();
    const options = {
      hostname: 'www.strava.com',
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { reject(new Error('Invalid response from Strava')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  setCORS(req, res);

  // Preflight
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Health check
  if (req.method === 'GET' && req.url === '/') {
    send(res, 200, { status: 'ok', service: 'Referee Fitness backend' }); return;
  }

  // ── /exchange  (authorization code → access token) ──────────────────────
  if (req.method === 'POST' && req.url === '/exchange') {
    try {
      const { code } = await readBody(req);
      if (!code) { send(res, 400, { error: 'Missing code' }); return; }

      const result = await stravaPost('/api/v3/oauth/token', {
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        grant_type:    'authorization_code'
      });

      if (result.status !== 200) {
        send(res, 502, { error: 'Strava token exchange failed', detail: result.body }); return;
      }

      const { access_token, refresh_token, expires_at, athlete } = result.body;
      send(res, 200, { access_token, refresh_token, expires_at, athlete });
    } catch(e) {
      send(res, 500, { error: e.message });
    }
    return;
  }

  // ── /refresh  (refresh token → new access token) ─────────────────────────
  if (req.method === 'POST' && req.url === '/refresh') {
    try {
      const { refresh_token } = await readBody(req);
      if (!refresh_token) { send(res, 400, { error: 'Missing refresh_token' }); return; }

      const result = await stravaPost('/api/v3/oauth/token', {
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token,
        grant_type:    'refresh_token'
      });

      if (result.status !== 200) {
        send(res, 502, { error: 'Strava token refresh failed', detail: result.body }); return;
      }

      const { access_token, refresh_token: new_refresh, expires_at } = result.body;
      send(res, 200, { access_token, refresh_token: new_refresh, expires_at });
    } catch(e) {
      send(res, 500, { error: e.message });
    }
    return;
  }

  send(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`Referee Fitness backend running on port ${PORT}`);
});
