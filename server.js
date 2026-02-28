'use strict';

const express    = require('express');
const http       = require('http');
const https      = require('https');
const WebSocket  = require('ws');
const path       = require('path');
const os         = require('os');

// ─── App & Server ────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── Language Config ─────────────────────────────────────────────────────────
// MyMemory language codes (some differ from BCP-47 speech codes)
const LANG_MYMEMORY = {
  en: 'en',
  es: 'es',
  fr: 'fr',
  zh: 'zh-CN',
  pt: 'pt',
};

// ─── Translation Cache ───────────────────────────────────────────────────────
const translationCache = new Map();
const CACHE_TTL_MS     = 10 * 60 * 1000; // 10 minutes

function cacheGet(key) {
  const entry = translationCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    translationCache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value) {
  translationCache.set(key, { value, ts: Date.now() });
}

// ─── Translation via MyMemory API ────────────────────────────────────────────
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
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.responseStatus === 200) {
            const translation = parsed.responseData.translatedText;
            cacheSet(cacheKey, translation);
            resolve(translation);
          } else {
            resolve(text); // Fallback to original
          }
        } catch {
          resolve(text);
        }
      });
    }).on('error', () => resolve(text));
  });
}

// ─── REST: Translation ────────────────────────────────────────────────────────
app.post('/api/translate', async (req, res) => {
  const { text, from, to } = req.body;
  if (!text || !from || !to) {
    return res.status(400).json({ error: 'text, from, and to are required' });
  }
  try {
    const translation = await translateText(text, from, to);
    res.json({ translation, original: text });
  } catch {
    res.status(500).json({ error: 'Translation service unavailable', original: text });
  }
});

// ─── REST: Topic Detection ────────────────────────────────────────────────────
// (Also performed client-side; this endpoint is provided for completeness)
const TOPIC_KEYWORDS = {
  'Work & Business':   ['work','job','meeting','project','deadline','office','boss','salary','client','business','email','report','presentation','interview','hire','manager'],
  'Family':            ['family','mom','dad','mother','father','sister','brother','children','kids','parents','grandma','grandpa','husband','wife','son','daughter','baby','nephew','niece'],
  'Health & Medical':  ['health','doctor','medicine','hospital','sick','pain','appointment','pharmacy','symptoms','feeling','tired','headache','nurse','prescription','surgery','diagnosis'],
  'Food & Dining':     ['food','restaurant','eat','dinner','lunch','breakfast','hungry','cook','recipe','meal','drink','coffee','pizza','burger','kitchen','chef','menu','order','taste'],
  'Weather':           ['weather','rain','sunny','cold','hot','temperature','forecast','storm','snow','wind','humid','cloudy','degrees','tornado','flood'],
  'Sports & Fitness':  ['sports','game','team','play','score','win','lose','match','tournament','ball','run','exercise','gym','training','fitness','coach','player','league'],
  'Travel':            ['travel','trip','vacation','flight','hotel','destination','passport','tour','visit','country','city','airport','map','tickets','cruise','itinerary'],
  'Technology':        ['phone','computer','app','internet','software','technology','device','digital','website','code','program','data','ai','robot','startup','cloud','api'],
  'Entertainment':     ['movie','music','show','concert','party','fun','game','book','read','watch','listen','streaming','song','film','theater','album','artist','episode'],
  'Education':         ['school','university','study','learn','class','teacher','student','homework','exam','grade','degree','college','lecture','thesis','curriculum','campus'],
  'Shopping':          ['shop','buy','store','mall','price','sale','discount','brand','product','order','delivery','shopping','online','cart','checkout','refund'],
  'Finance':           ['money','bank','pay','bill','rent','tax','investment','savings','loan','budget','spend','income','finance','credit','debt','mortgage','stock'],
};

function detectTopicFromText(text) {
  const words = text.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  let best = { topic: null, score: 0 };
  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    const score = words.filter((w) => keywords.includes(w)).length;
    if (score > best.score) best = { topic, score };
  }
  return best.score >= 2 ? best.topic : null;
}

app.post('/api/topic', (req, res) => {
  const topic = detectTopicFromText(req.body.text || '');
  res.json({ topic: topic || 'General Conversation' });
});

// ─── Room Management ──────────────────────────────────────────────────────────
const rooms = new Map(); // code → { headset, phone, headsetLang, phoneLang, profile }

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 5; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

function safeSend(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// ─── WebSocket Handler ────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  ws.roomCode   = null;
  ws.role       = null; // 'headset' | 'phone'
  ws.isAlive    = true;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (rawData) => {
    let msg;
    try { msg = JSON.parse(rawData); } catch { return; }

    const room = ws.roomCode ? rooms.get(ws.roomCode) : null;

    switch (msg.type) {

      // ── Headset creates a room ────────────────────────────────────────────
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

      // ── Phone joins a room ────────────────────────────────────────────────
      case 'join_room': {
        const code = (msg.code || '').toUpperCase().trim();
        const r    = rooms.get(code);

        if (!r) {
          safeSend(ws, { type: 'error', message: 'Room not found — check the code.' });
          return;
        }
        if (r.phone) {
          safeSend(ws, { type: 'error', message: 'Room is already occupied.' });
          return;
        }

        r.phone     = ws;
        ws.roomCode = code;
        ws.role     = 'phone';

        if (msg.profile)  r.profile  = { ...r.profile,  ...msg.profile  };
        if (msg.phoneLang) r.phoneLang = msg.phoneLang;

        safeSend(ws, {
          type:        'room_joined',
          code,
          headsetLang: r.headsetLang,
          phoneLang:   r.phoneLang,
          profile:     r.profile,
        });
        safeSend(r.headset, {
          type:      'phone_connected',
          profile:   r.profile,
          phoneLang: r.phoneLang,
        });
        break;
      }

      // ── Either side updates the speaker profile ───────────────────────────
      case 'update_profile': {
        if (!room) return;
        room.profile = { ...room.profile, ...msg.profile };
        [room.headset, room.phone].forEach((c) =>
          safeSend(c, { type: 'profile_updated', profile: room.profile })
        );
        break;
      }

      // ── Either side updates their language preference ─────────────────────
      case 'update_lang': {
        if (!room) return;
        if (ws.role === 'headset') room.headsetLang = msg.lang;
        else                       room.phoneLang   = msg.lang;
        [room.headset, room.phone].forEach((c) =>
          safeSend(c, { type: 'lang_updated', headsetLang: room.headsetLang, phoneLang: room.phoneLang })
        );
        break;
      }

      // ── Speech from either side (needs translation & relay) ───────────────
      case 'speech': {
        if (!room) return;
        const { text, isFinal } = msg;

        if (!isFinal || !text.trim()) {
          // Relay interim back to sender for immediate display
          safeSend(ws, { type: 'speech_interim', text });
          return;
        }

        if (ws.role === 'headset') {
          // Headset spoke → translate to phone language → send to phone
          const translated = await translateText(text, room.headsetLang, room.phoneLang);
          safeSend(room.phone, {
            type:       'translated_speech',
            original:   text,
            translated,
            from:       'headset',
          });
          // Echo original back to headset for their own caption log
          safeSend(ws, { type: 'speech_echo', text, role: 'headset' });

        } else {
          // Phone spoke → translate to headset language → send to headset
          const translated = await translateText(text, room.phoneLang, room.headsetLang);
          safeSend(room.headset, {
            type:       'translated_speech',
            original:   text,
            translated,
            from:       'phone',
          });
          // Echo original back to phone for their own caption log
          safeSend(ws, { type: 'speech_echo', text, role: 'phone' });
        }
        break;
      }

      // ── Keep-alive ────────────────────────────────────────────────────────
      case 'ping': {
        safeSend(ws, { type: 'pong' });
        break;
      }
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
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30_000);
wss.on('close', () => clearInterval(heartbeat));

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  const nets    = os.networkInterfaces();
  const localIPs = [];
  for (const iface of Object.values(nets)) {
    for (const net of iface) {
      if (net.family === 'IPv4' && !net.internal) localIPs.push(net.address);
    }
  }

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║      AR Caption Companion  —  Ready          ║');
  console.log('╚══════════════════════════════════════════════╝\n');
  console.log(`  Local:   http://localhost:${PORT}`);
  localIPs.forEach((ip) => console.log(`  Network: http://${ip}:${PORT}`));
  console.log('\n  ┌─ Pages ─────────────────────────────────────┐');
  console.log('  │  Quest AR App  →  /                         │');
  console.log('  │  Phone Companion  →  /phone.html            │');
  console.log('  └─────────────────────────────────────────────┘');
  console.log('\n  ⚠  Meta Quest 3 requires HTTPS for WebXR.');
  console.log('     Run:  npx ngrok http ' + PORT);
  console.log('     Then open the ngrok URL on your Quest.\n');
});
