'use strict';

const express   = require('express');
const http      = require('http');
const https     = require('https');
const WebSocket = require('ws');
const path      = require('path');
const fs        = require('fs');
const os        = require('os');

// ─── Self-signed TLS cert (auto-generated, cached on disk) ───────────────────
// Meta Quest Browser requires HTTPS for WebXR and microphone access.
const CERT_DIR  = path.join(__dirname, '.certs');
const CERT_FILE = path.join(CERT_DIR, 'cert.pem');
const KEY_FILE  = path.join(CERT_DIR, 'key.pem');

function getLocalIPs() {
  const nets = os.networkInterfaces();
  const ips  = [];
  for (const iface of Object.values(nets)) {
    for (const net of iface) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}

function generateCert() {
  console.log('  Generating self-signed TLS certificate…');
  const selfsigned = require('selfsigned');
  const localIPs   = getLocalIPs();

  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...localIPs.map((ip) => ({ type: 7, ip })),
  ];

  const pems = selfsigned.generate(
    [{ name: 'commonName', value: 'ar-caption-companion' }],
    {
      days:      825,   // Chrome max for self-signed
      algorithm: 'sha256',
      keySize:   2048,
      extensions: [{ name: 'subjectAltName', altNames }],
    }
  );

  fs.mkdirSync(CERT_DIR, { recursive: true });
  fs.writeFileSync(CERT_FILE, pems.cert,    { mode: 0o600 });
  fs.writeFileSync(KEY_FILE,  pems.private, { mode: 0o600 });
  console.log(`  Certificate saved to ${CERT_DIR}`);
  return { cert: pems.cert, key: pems.private };
}

function loadOrCreateCert() {
  if (fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE)) {
    return {
      cert: fs.readFileSync(CERT_FILE, 'utf8'),
      key:  fs.readFileSync(KEY_FILE,  'utf8'),
    };
  }
  return generateCert();
}

// ─── Express App ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── Language Config ──────────────────────────────────────────────────────────
const LANG_MYMEMORY = { en: 'en', es: 'es', fr: 'fr', zh: 'zh-CN', pt: 'pt' };

// ─── Translation Cache ────────────────────────────────────────────────────────
const translationCache = new Map();
const CACHE_TTL_MS     = 10 * 60 * 1000;

function cacheGet(key) {
  const entry = translationCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { translationCache.delete(key); return null; }
  return entry.value;
}
function cacheSet(key, value) { translationCache.set(key, { value, ts: Date.now() }); }

// ─── Translation via MyMemory API ─────────────────────────────────────────────
function translateText(text, from, to) {
  return new Promise((resolve) => {
    if (!text || !text.trim()) { resolve(text); return; }
    if (from === to)            { resolve(text); return; }

    const fromCode = LANG_MYMEMORY[from] || from;
    const toCode   = LANG_MYMEMORY[to]   || to;
    const cacheKey = `${fromCode}|${toCode}|${text}`;
    const cached   = cacheGet(cacheKey);
    if (cached) { resolve(cached); return; }

    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${fromCode}|${toCode}`;

    https.get(url, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.responseStatus === 200) {
            cacheSet(cacheKey, parsed.responseData.translatedText);
            resolve(parsed.responseData.translatedText);
          } else {
            resolve(text);
          }
        } catch { resolve(text); }
      });
    }).on('error', () => resolve(text));
  });
}

// ─── REST: Translate ──────────────────────────────────────────────────────────
app.post('/api/translate', async (req, res) => {
  const { text, from, to } = req.body;
  if (!text || !from || !to) return res.status(400).json({ error: 'text, from, to required' });
  const translation = await translateText(text, from, to);
  res.json({ translation, original: text });
});

// ─── REST: Topic Detection ────────────────────────────────────────────────────
const TOPIC_KEYWORDS = {
  'Work & Business':   ['work','job','meeting','project','deadline','office','boss','salary','client','business','email','report','presentation','interview','manager'],
  'Family':            ['family','mom','dad','mother','father','sister','brother','children','kids','parents','grandma','grandpa','husband','wife','son','daughter','baby'],
  'Health & Medical':  ['health','doctor','medicine','hospital','sick','pain','appointment','pharmacy','symptoms','feeling','tired','headache','nurse','prescription'],
  'Food & Dining':     ['food','restaurant','eat','dinner','lunch','breakfast','hungry','cook','recipe','meal','drink','coffee','pizza','burger','kitchen','chef'],
  'Weather':           ['weather','rain','sunny','cold','hot','temperature','forecast','storm','snow','wind','humid','cloudy','degrees'],
  'Sports & Fitness':  ['sports','game','team','play','score','win','lose','match','tournament','ball','run','exercise','gym','training','fitness'],
  'Travel':            ['travel','trip','vacation','flight','hotel','destination','passport','tour','visit','country','city','airport','map','tickets'],
  'Technology':        ['phone','computer','app','internet','software','technology','device','digital','website','code','program','data','ai','robot'],
  'Entertainment':     ['movie','music','show','concert','party','fun','game','book','read','watch','listen','streaming','song','film','theater'],
  'Education':         ['school','university','study','learn','class','teacher','student','homework','exam','grade','degree','college','lecture'],
};

app.post('/api/topic', (req, res) => {
  const words = (req.body.text || '').toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  let best = { topic: null, score: 0 };
  for (const [topic, kw] of Object.entries(TOPIC_KEYWORDS)) {
    const score = words.filter((w) => kw.includes(w)).length;
    if (score > best.score) best = { topic, score };
  }
  res.json({ topic: best.score >= 2 ? best.topic : 'General Conversation' });
});

// ─── Room Management ──────────────────────────────────────────────────────────
const rooms = new Map();

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 5; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

function safeSend(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

// ─── WebSocket Handler (shared between HTTP and HTTPS) ────────────────────────
function setupWSHandlers(wss) {
  wss.on('connection', (ws) => {
    ws.roomCode = null;
    ws.role     = null;
    ws.isAlive  = true;

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (rawData) => {
      let msg;
      try { msg = JSON.parse(rawData); } catch { return; }

      const room = ws.roomCode ? rooms.get(ws.roomCode) : null;

      switch (msg.type) {

        case 'create_room': {
          if (ws.roomCode) rooms.delete(ws.roomCode);
          let code;
          do { code = genCode(); } while (rooms.has(code));

          rooms.set(code, {
            headset:     ws,
            phone:       null,
            headsetLang: msg.headsetLang || 'en',
            phoneLang:   msg.phoneLang   || 'es',
            profile:     { name: '', relationship: '', phoneLang: msg.phoneLang || 'es' },
          });
          ws.roomCode = code;
          ws.role     = 'headset';
          safeSend(ws, { type: 'room_created', code });
          break;
        }

        case 'join_room': {
          const code = (msg.code || '').toUpperCase().trim();
          const r    = rooms.get(code);
          if (!r)      { safeSend(ws, { type: 'error', message: 'Room not found — check the code.' }); return; }
          if (r.phone) { safeSend(ws, { type: 'error', message: 'Room is already occupied.' });         return; }

          r.phone     = ws;
          ws.roomCode = code;
          ws.role     = 'phone';
          if (msg.profile)   r.profile   = { ...r.profile,   ...msg.profile   };
          if (msg.phoneLang) r.phoneLang = msg.phoneLang;

          safeSend(ws, { type: 'room_joined', code, headsetLang: r.headsetLang, phoneLang: r.phoneLang, profile: r.profile });
          safeSend(r.headset, { type: 'phone_connected', profile: r.profile, phoneLang: r.phoneLang });
          break;
        }

        case 'update_profile': {
          if (!room) return;
          room.profile = { ...room.profile, ...msg.profile };
          [room.headset, room.phone].forEach((c) => safeSend(c, { type: 'profile_updated', profile: room.profile }));
          break;
        }

        case 'update_lang': {
          if (!room) return;
          if (ws.role === 'headset') room.headsetLang = msg.lang;
          else                       room.phoneLang   = msg.lang;
          [room.headset, room.phone].forEach((c) =>
            safeSend(c, { type: 'lang_updated', headsetLang: room.headsetLang, phoneLang: room.phoneLang })
          );
          break;
        }

        case 'speech': {
          if (!room) return;
          const { text, isFinal } = msg;
          if (!isFinal || !text.trim()) { safeSend(ws, { type: 'speech_interim', text }); return; }

          if (ws.role === 'headset') {
            const translated = await translateText(text, room.headsetLang, room.phoneLang);
            safeSend(room.phone,    { type: 'translated_speech', original: text, translated, from: 'headset' });
            safeSend(ws,            { type: 'speech_echo', text, role: 'headset' });
          } else {
            const translated = await translateText(text, room.phoneLang, room.headsetLang);
            safeSend(room.headset,  { type: 'translated_speech', original: text, translated, from: 'phone' });
            safeSend(ws,            { type: 'speech_echo', text, role: 'phone' });
          }
          break;
        }

        case 'ping': safeSend(ws, { type: 'pong' }); break;
      }
    });

    ws.on('close', () => {
      if (!ws.roomCode) return;
      const r = rooms.get(ws.roomCode);
      if (!r) return;
      if (ws.role === 'headset') {
        safeSend(r.phone, { type: 'headset_disconnected' });
        rooms.delete(ws.roomCode);
      } else {
        r.phone = null;
        safeSend(r.headset, { type: 'phone_disconnected' });
      }
    });
  });

  // Heartbeat: terminate dead connections every 30 s
  const hb = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) { ws.terminate(); return; }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30_000);
  wss.on('close', () => clearInterval(hb));
}

// ─── Servers ──────────────────────────────────────────────────────────────────
const HTTP_PORT  = parseInt(process.env.PORT  || '3000', 10);
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '3443', 10);

// HTTP server (local dev / fallback)
const httpServer = http.createServer(app);
const wssHttp    = new WebSocket.Server({ server: httpServer });
setupWSHandlers(wssHttp);

// HTTPS server (required for Meta Quest — WebXR + microphone need HTTPS)
let httpsServer, wssHttps;
try {
  const sslOptions = loadOrCreateCert();
  httpsServer = https.createServer(sslOptions, app);
  wssHttps    = new WebSocket.Server({ server: httpsServer });
  setupWSHandlers(wssHttps);
} catch (err) {
  console.error('  ✗ Could not start HTTPS server:', err.message);
  console.error('    Install selfsigned: npm install selfsigned');
}

// ─── Start ────────────────────────────────────────────────────────────────────
const localIPs = getLocalIPs();

httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  if (httpsServer) return; // quiet if HTTPS is also starting
  console.log(`\n  HTTP only — http://localhost:${HTTP_PORT}`);
});

if (httpsServer) {
  httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║      AR Caption Companion  —  Ready              ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    console.log('  HTTP  (local dev):');
    console.log(`    http://localhost:${HTTP_PORT}`);
    localIPs.forEach((ip) => console.log(`    http://${ip}:${HTTP_PORT}`));

    console.log('\n  HTTPS (Meta Quest — use these URLs):');
    console.log(`    https://localhost:${HTTPS_PORT}`);
    localIPs.forEach((ip) => console.log(`    https://${ip}:${HTTPS_PORT}  ← Quest AR App`));

    console.log('\n  ┌──────────────────────────────────────────────┐');
    console.log('  │  Quest AR App    →  /                        │');
    console.log('  │  Phone Companion →  /phone.html              │');
    console.log('  └──────────────────────────────────────────────┘');
    console.log('\n  ⚠  First visit on Quest: tap "Advanced" → "Proceed"');
    console.log('     to accept the self-signed cert.\n');
  });
}
