/* ════════════════════════════════════════════════════════════════════════════
   AR Caption Companion — Phone Companion Application
   ════════════════════════════════════════════════════════════════════════════ */

'use strict';

// ── Language Config ────────────────────────────────────────────────────────
const LANGUAGES = {
  en: { name: 'English',          flag: '🇺🇸', speech: 'en-US' },
  es: { name: 'Spanish',          flag: '🇪🇸', speech: 'es-ES' },
  fr: { name: 'French',           flag: '🇫🇷', speech: 'fr-FR' },
  zh: { name: 'Mandarin Chinese', flag: '🇨🇳', speech: 'zh-CN' },
  pt: { name: 'Portuguese',       flag: '🇧🇷', speech: 'pt-BR' },
};

// ── State ─────────────────────────────────────────────────────────────────
const state = {
  ws:            null,
  wsReady:       false,
  connected:     false,
  roomCode:      null,

  phoneLang:     'es',
  headsetLang:   'en',

  profile: { name: '', relationship: '' },

  recognition:    null,
  speechSupported: false,
  isListening:    false,
  isSpeaking:     false,
  restartTimeout: null,

  history:       [],  // [{ from, text, translated }]
};

// ── DOM helpers ───────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

// ═══════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', init);

function init() {
  // Restore saved prefs
  const savedLang = localStorage.getItem('phoneLang') || 'es';
  const savedName = localStorage.getItem('phoneName') || '';
  const savedRel  = localStorage.getItem('phoneRel')  || '';

  $('phone-lang-select').value = savedLang;
  $('profile-name').value      = savedName;
  $('profile-rel').value       = savedRel;
  state.phoneLang              = savedLang;

  // Pre-fill from URL ?room= param
  const params = new URLSearchParams(location.search);
  const roomFromUrl = params.get('room') || params.get('code');
  if (roomFromUrl) {
    $('room-code-input').value = roomFromUrl.toUpperCase();
  }

  setupWebSocket();
  setupSpeechRecognition();
  setupUIHandlers();
}

// ═══════════════════════════════════════════════════════════════════════════
// WEBSOCKET
// ═══════════════════════════════════════════════════════════════════════════
function setupWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url   = `${proto}//${location.host}`;

  function connect() {
    const ws = new WebSocket(url);
    state.ws = ws;

    ws.onopen = () => {
      state.wsReady = true;
    };

    ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      handleWsMessage(msg);
    };

    ws.onclose = () => {
      state.wsReady   = false;
      state.connected = false;
      updateConnPill(false);
      setTimeout(connect, 2000);
    };

    ws.onerror = () => ws.close();
  }

  connect();
}

function wsSend(data) {
  if (state.ws && state.wsReady) {
    state.ws.send(JSON.stringify(data));
  }
}

function handleWsMessage(msg) {
  switch (msg.type) {

    case 'room_joined': {
      state.connected   = true;
      state.headsetLang = msg.headsetLang;
      state.phoneLang   = msg.phoneLang;
      state.roomCode    = msg.code;
      showSession();
      updateConnPill(true);
      updateSpeakerHeader();
      showToast('Connected to Quest headset!');
      break;
    }

    case 'headset_disconnected': {
      state.connected = false;
      updateConnPill(false);
      showToast('Headset disconnected');
      stopListening();
      // Return to join screen
      setTimeout(showJoin, 1500);
      break;
    }

    case 'profile_updated': {
      // Headset updated the profile
      break;
    }

    case 'lang_updated': {
      state.headsetLang = msg.headsetLang;
      state.phoneLang   = msg.phoneLang;
      // Restart recognition with updated language
      if (state.isListening) restartRecognition();
      updateSpeakerHeader();
      break;
    }

    case 'translated_speech': {
      // from === 'headset' means headset user spoke; show translated text on phone
      if (msg.from === 'headset') {
        showTranslation(msg.translated, msg.original);
        addHistory('headset', msg.original, msg.translated);
      }
      break;
    }

    case 'error': {
      $('room-error').textContent = msg.message || 'An error occurred.';
      $('room-error').classList.add('visible');
      $('join-btn').disabled = false;
      $('join-btn').innerHTML = '<span>🔗</span> Connect to Quest';
      break;
    }

    case 'pong': break;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SPEECH RECOGNITION
// ═══════════════════════════════════════════════════════════════════════════
function setupSpeechRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    state.speechSupported = false;
    console.warn('[Speech] Not supported on this browser');
    return;
  }
  state.speechSupported = true;

  const rec = new SR();
  rec.continuous     = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  rec.lang = LANGUAGES[state.phoneLang]?.speech || 'es-ES';

  rec.onstart = () => {
    state.isListening = true;
    $('mic-btn').className   = 'mic-btn active';
    $('mic-status-text').textContent = 'Listening…';
  };

  rec.onresult = (evt) => {
    let interim = '';
    let final   = '';

    for (let i = evt.resultIndex; i < evt.results.length; i++) {
      const t = evt.results[i][0].transcript.trim();
      if (evt.results[i].isFinal) final  += ' ' + t;
      else                         interim += ' ' + t;
    }

    interim = interim.trim();
    final   = final.trim();

    if (interim) {
      $('mic-transcript').textContent = interim;
    }

    if (final) {
      $('mic-transcript').textContent = '';
      addHistory('phone', final, null); // translated version arrives via server echo
      wsSend({ type: 'speech', text: final, isFinal: true });
    }
  };

  rec.onspeechstart = () => {
    state.isSpeaking = true;
    $('mic-btn').className = 'mic-btn speaking';
    $('mic-status-text').textContent = 'Speaking…';
  };

  rec.onspeechend = () => {
    state.isSpeaking = false;
    $('mic-btn').className = state.isListening ? 'mic-btn active' : 'mic-btn muted';
    $('mic-status-text').textContent = state.isListening ? 'Listening…' : 'Tap mic to speak';
  };

  rec.onerror = (evt) => {
    if (evt.error === 'not-allowed' || evt.error === 'service-not-allowed') {
      state.speechSupported = false;
      showToast('Mic access denied');
      return;
    }
    if (evt.error !== 'no-speech') {
      console.warn('[Speech] Error:', evt.error);
    }
  };

  rec.onend = () => {
    state.isSpeaking = false;
    if (state.isListening) {
      state.restartTimeout = setTimeout(() => {
        try { rec.start(); } catch {}
      }, 200);
    } else {
      $('mic-btn').className = 'mic-btn muted';
      $('mic-status-text').textContent = 'Tap mic to speak';
    }
  };

  state.recognition = rec;
}

function startListening() {
  if (!state.speechSupported || !state.recognition) return;
  state.isListening = true;
  state.recognition.lang = LANGUAGES[state.phoneLang]?.speech || 'es-ES';
  try { state.recognition.start(); } catch {}
}

function stopListening() {
  state.isListening = false;
  clearTimeout(state.restartTimeout);
  try { state.recognition.stop(); } catch {}
  $('mic-btn').className          = 'mic-btn muted';
  $('mic-status-text').textContent = 'Tap mic to speak';
  $('mic-transcript').textContent  = '';
}

function restartRecognition() {
  stopListening();
  setTimeout(startListening, 300);
}

// ═══════════════════════════════════════════════════════════════════════════
// UI HANDLERS
// ═══════════════════════════════════════════════════════════════════════════
function setupUIHandlers() {
  // Language change
  $('phone-lang-select').addEventListener('change', (e) => {
    state.phoneLang = e.target.value;
    localStorage.setItem('phoneLang', state.phoneLang);
    if (state.isListening) restartRecognition();
    if (state.connected) {
      wsSend({ type: 'update_lang', lang: state.phoneLang });
    }
  });

  // Save name/rel
  $('profile-name').addEventListener('input', (e) => {
    localStorage.setItem('phoneName', e.target.value);
  });
  $('profile-rel').addEventListener('input', (e) => {
    localStorage.setItem('phoneRel', e.target.value);
  });

  // Room code — auto uppercase
  $('room-code-input').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase();
    $('room-error').classList.remove('visible');
  });
  $('room-code-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('join-btn').click();
  });

  // Join button
  $('join-btn').addEventListener('click', () => {
    const code = $('room-code-input').value.trim().toUpperCase();
    if (code.length < 4) {
      $('room-error').textContent = 'Please enter a valid room code.';
      $('room-error').classList.add('visible');
      return;
    }

    if (!state.wsReady) {
      showToast('Connecting to server…');
      return;
    }

    $('join-btn').disabled = true;
    $('join-btn').innerHTML = '<span>⏳</span> Connecting…';
    $('room-error').classList.remove('visible');

    state.phoneLang = $('phone-lang-select').value;
    const name = $('profile-name').value.trim();
    const rel  = $('profile-rel').value.trim();

    wsSend({
      type:      'join_room',
      code,
      phoneLang: state.phoneLang,
      profile:   { name, relationship: rel, phoneLang: state.phoneLang },
    });
  });

  // Mic button (toggle)
  $('mic-btn').addEventListener('click', () => {
    if (!state.speechSupported) {
      showToast('Speech not supported on this browser');
      return;
    }
    if (state.isListening) {
      stopListening();
      showToast('Microphone muted');
    } else {
      startListening();
      showToast('Microphone on');
    }
  });

  // Disconnect
  $('disconnect-btn').addEventListener('click', () => {
    stopListening();
    state.ws?.close();
    showJoin();
    updateConnPill(false);
    showToast('Disconnected');
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// DISPLAY HELPERS
// ═══════════════════════════════════════════════════════════════════════════
function showSession() {
  $('join-screen').classList.remove('active');
  $('session-screen').classList.add('active');
  updateConnPill(true);
  updateSpeakerHeader();
  // Auto-start listening
  startListening();
}

function showJoin() {
  $('session-screen').classList.remove('active');
  $('join-screen').classList.add('active');
  $('join-btn').disabled = false;
  $('join-btn').innerHTML = '<span>🔗</span> Connect to Quest';
  $('translated-text').textContent = 'Waiting for speech from Quest…';
  $('translated-text').classList.add('empty');
  $('original-text').classList.remove('visible');
  clearHistory();
}

function updateConnPill(connected) {
  const pill = $('conn-pill');
  const text = $('conn-pill-text');
  if (connected) {
    pill.classList.add('connected');
    text.textContent = 'Connected';
  } else {
    pill.classList.remove('connected');
    text.textContent = 'Not connected';
  }
}

function updateSpeakerHeader() {
  const headsetLangInfo = LANGUAGES[state.headsetLang];
  const phoneLangInfo   = LANGUAGES[state.phoneLang];

  $('sess-headset-label').textContent = 'Quest User';
  $('sess-lang-label').textContent    = `Speaking: ${headsetLangInfo?.name || state.headsetLang}`;
  $('sess-lang-badge').textContent    = headsetLangInfo ? `${headsetLangInfo.flag} ${headsetLangInfo.name}` : state.headsetLang;
  $('they-lang-label').textContent    = `→ ${phoneLangInfo?.name || state.phoneLang}`;
}

function showTranslation(translated, original) {
  const el   = $('translated-text');
  const orig = $('original-text');

  el.textContent = translated;
  el.classList.remove('empty');

  if (original && original !== translated) {
    orig.textContent = `Original: "${original}"`;
    orig.classList.add('visible');
  } else {
    orig.classList.remove('visible');
  }

  // Haptic feedback
  if (navigator.vibrate) navigator.vibrate(30);
}

function addHistory(from, text, translated) {
  const list = $('history-list');

  // Remove empty placeholder
  const empty = list.querySelector('.history-empty');
  if (empty) empty.remove();

  const item = document.createElement('div');
  item.className = `history-item from-${from}`;

  const label = document.createElement('div');
  label.className = 'history-item-label';
  label.textContent = from === 'headset' ? 'Quest User' : 'You';
  item.appendChild(label);

  const body = document.createElement('div');
  body.textContent = text;
  if (translated && translated !== text) {
    body.textContent = `${translated}`;
    const sub = document.createElement('div');
    sub.style.cssText = 'font-size:11px; opacity:0.45; margin-top:2px;';
    sub.textContent = `"${text}"`;
    item.appendChild(body);
    item.appendChild(sub);
  } else {
    item.appendChild(body);
  }

  list.appendChild(item);

  // Auto-scroll
  list.scrollTop = list.scrollHeight;

  // Keep max 30 history items
  const items = list.querySelectorAll('.history-item');
  if (items.length > 30) items[0].remove();

  state.history.push({ from, text, translated });
}

function clearHistory() {
  const list = $('history-list');
  list.innerHTML = '<div class="history-empty">No messages yet</div>';
  state.history = [];
}

// ═══════════════════════════════════════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════════════════════════════════════
let toastTimer = null;
function showToast(msg, duration = 2500) {
  const el = $('phone-toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}
