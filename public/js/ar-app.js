/* ════════════════════════════════════════════════════════════════════════════
   AR Caption Companion — Headset (Quest 3) Application
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

// ── Topic Keywords ────────────────────────────────────────────────────────
const TOPICS = {
  'Work & Business':   { icon: '💼', words: ['work','job','meeting','project','deadline','office','boss','salary','client','business','email','report','presentation','interview','manager','hire','contract'] },
  'Family':            { icon: '👨‍👩‍👧', words: ['family','mom','dad','mother','father','sister','brother','children','kids','parents','grandma','grandpa','husband','wife','son','daughter','baby','nephew','niece'] },
  'Health & Medical':  { icon: '🏥', words: ['health','doctor','medicine','hospital','sick','pain','appointment','pharmacy','symptoms','feeling','tired','headache','nurse','prescription','surgery','diagnosis','fever','allergy'] },
  'Food & Dining':     { icon: '🍽️', words: ['food','restaurant','eat','dinner','lunch','breakfast','hungry','cook','recipe','meal','drink','coffee','pizza','burger','kitchen','chef','menu','order','taste','delicious'] },
  'Weather':           { icon: '⛅', words: ['weather','rain','sunny','cold','hot','temperature','forecast','storm','snow','wind','humid','cloudy','degrees','tornado','flood','sunshine','freezing'] },
  'Sports & Fitness':  { icon: '⚽', words: ['sports','game','team','play','score','win','lose','match','tournament','ball','run','exercise','gym','training','fitness','coach','player','league','championship'] },
  'Travel':            { icon: '✈️', words: ['travel','trip','vacation','flight','hotel','destination','passport','tour','visit','country','city','airport','map','tickets','cruise','itinerary','suitcase','boarding'] },
  'Technology':        { icon: '💻', words: ['phone','computer','app','internet','software','technology','device','digital','website','code','program','data','ai','robot','startup','cloud','api','screen','update','download'] },
  'Entertainment':     { icon: '🎬', words: ['movie','music','show','concert','party','fun','game','book','read','watch','listen','streaming','song','film','theater','album','artist','episode','series','festival'] },
  'Education':         { icon: '📚', words: ['school','university','study','learn','class','teacher','student','homework','exam','grade','degree','college','lecture','thesis','curriculum','campus','scholarship','graduate'] },
  'Shopping':          { icon: '🛍️', words: ['shop','buy','store','mall','price','sale','discount','brand','product','order','delivery','shopping','online','cart','checkout','refund','return','expensive','cheap'] },
  'Finance':           { icon: '💰', words: ['money','bank','pay','bill','rent','tax','investment','savings','loan','budget','spend','income','finance','credit','debt','mortgage','stock','transfer','payment'] },
};

// ── Application State ─────────────────────────────────────────────────────
const state = {
  xrSession:       null,
  gl:              null,
  ws:              null,
  wsReady:         false,
  roomCode:        null,
  phoneConnected:  false,
  standalone:      false,

  headsetLang:     'en',
  phoneLang:       'es',

  profile: { name: '', relationship: '', phoneLang: 'es' },

  settings: {
    captions: true,
    topic:    true,
    haptics:  false,
  },

  recognition:      null,
  speechSupported:  false,
  isListening:      false,
  isSpeaking:       false,
  restartTimeout:   null,
  vadActive:        false,

  captionLines:    [],   // [{ el, timer }]
  interimEl:       null,
  topicBuffer:     [],   // [{ text, ts }]
  topicTimer:      null,
  currentTopic:    null,

  xrSupported:     false,
};

// ── DOM refs ──────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

// ═══════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', init);

async function init() {
  // Warn on HTTP (WebXR needs HTTPS except localhost)
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    $('https-warning').classList.remove('hidden');
  }

  // Read saved language prefs
  state.headsetLang = localStorage.getItem('headsetLang') || 'en';
  state.phoneLang   = localStorage.getItem('phoneLang')   || 'es';
  $('headset-lang').value     = state.headsetLang;
  $('phone-lang-setup').value = state.phoneLang;

  setupWebSocket();
  setupSpeechRecognition();
  setupPushToTalk();    // PTT button wired up after DOM ready
  setupUIHandlers();
  checkXRSupport();
  updatePhoneUrlHint();
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
      createRoom();
    };

    ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      handleWsMessage(msg);
    };

    ws.onclose = () => {
      state.wsReady = false;
      state.phoneConnected = false;
      updateConnectionUI(false);
      // Reconnect after 2 s
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

function createRoom() {
  wsSend({
    type:        'create_room',
    headsetLang: state.headsetLang,
    phoneLang:   state.phoneLang,
  });
}

function handleWsMessage(msg) {
  switch (msg.type) {

    case 'room_created': {
      state.roomCode = msg.code;
      updateRoomCodeDisplay(msg.code);
      updateConnectionUI(false);
      break;
    }

    case 'phone_connected': {
      state.phoneConnected = true;
      if (msg.profile)  updateProfileDisplay(msg.profile);
      if (msg.phoneLang) state.phoneLang = msg.phoneLang;
      updateConnectionUI(true);
      triggerHaptic('light');
      showToast(`${msg.profile?.name || 'Companion'} connected`);
      $('enter-ar-btn').disabled = false;
      // Update status in setup screen
      const statusEl = $('setup-conn-status');
      if (statusEl) {
        statusEl.textContent = 'Connected ✓';
        statusEl.classList.remove('waiting');
      }
      break;
    }

    case 'phone_disconnected': {
      state.phoneConnected = false;
      updateConnectionUI(false);
      showToast('Companion disconnected');
      resetProfileDisplay();
      break;
    }

    case 'profile_updated': {
      updateProfileDisplay(msg.profile);
      break;
    }

    case 'lang_updated': {
      state.headsetLang = msg.headsetLang;
      state.phoneLang   = msg.phoneLang;
      // Restart recognition with new language
      if (state.isListening) restartRecognition();
      break;
    }

    case 'translated_speech': {
      // msg.from === 'phone' → phone user spoke, show translated text on Quest
      if (msg.from === 'phone') {
        addCaptionLine(msg.translated, 'other',
          msg.original !== msg.translated ? `(${msg.original})` : null);
        if (state.settings.topic) feedTopicBuffer(msg.translated);
        triggerHaptic('medium');
      }
      break;
    }

    case 'speech_echo': {
      // Our own spoken text echoed back (not used for display — we show locally)
      break;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SPEECH — PRIMARY: Web Speech API
// ═══════════════════════════════════════════════════════════════════════════
function setupSpeechRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    console.warn('[Speech] Web Speech API unavailable — using MediaRecorder fallback.');
    initMediaRecorderFallback();
    return;
  }
  state.speechSupported = true;

  const rec = new SR();
  rec.continuous      = true;
  rec.interimResults  = true;
  rec.maxAlternatives = 1;
  rec.lang            = LANGUAGES[state.headsetLang]?.speech || 'en-US';

  rec.onstart = () => {
    state.isListening = true;
    $('mic-indicator').className = 'active';
    $('ptt-btn') && ($('ptt-btn').style.display = 'none');
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
    if (interim) showInterimCaption(interim);
    if (final) {
      clearInterimCaption();
      if (state.settings.captions) addCaptionLine(final, 'self');
      if (state.settings.topic)    feedTopicBuffer(final);
      if (!state.standalone)       wsSend({ type: 'speech', text: final, isFinal: true });
    }
  };

  rec.onerror = (evt) => {
    console.warn('[Speech] Error:', evt.error);
    if (evt.error === 'service-not-allowed' || evt.error === 'not-allowed') {
      // Quest Browser doesn't have Google's speech service → switch to
      // getUserMedia + MediaRecorder + server-side Whisper transcription.
      console.warn('[Speech] Service unavailable — switching to MediaRecorder fallback.');
      state.speechSupported = false;
      state.isListening     = false;
      try { rec.abort(); } catch {}
      initMediaRecorderFallback();
    }
    // 'no-speech' is benign; auto-restart handles it via onend.
  };

  rec.onend = () => {
    state.isSpeaking = false;
    $('mic-indicator').className = state.isListening ? 'active' : 'off';
    if (state.isListening && state.speechSupported) {
      state.restartTimeout = setTimeout(() => { try { rec.start(); } catch {} }, 150);
    }
  };

  rec.onspeechstart = () => { state.isSpeaking = true;  $('mic-indicator').className = 'speaking'; };
  rec.onspeechend   = () => { state.isSpeaking = false; $('mic-indicator').className = state.isListening ? 'active' : 'off'; };

  state.recognition = rec;
}

function startListening() {
  if (state.vadActive) return; // VAD fallback is running
  if (!state.speechSupported || !state.recognition) return;
  state.isListening = true;
  state.recognition.lang = LANGUAGES[state.headsetLang]?.speech || 'en-US';
  try { state.recognition.start(); } catch {}
}

function stopListening() {
  state.isListening = false;
  clearTimeout(state.restartTimeout);
  try { state.recognition?.stop(); } catch {}
  stopVAD();
  $('mic-indicator').className = 'off';
}

function restartRecognition() {
  stopListening();
  setTimeout(startListening, 300);
}

// ═══════════════════════════════════════════════════════════════════════════
// SPEECH — FALLBACK: getUserMedia + MediaRecorder + VAD + Whisper
// Used on Meta Quest Browser where webkitSpeechRecognition is unavailable.
// ═══════════════════════════════════════════════════════════════════════════

// Shared state for the fallback pipeline
const vad = {
  stream:      null,
  audioCtx:    null,
  analyser:    null,
  recorder:    null,
  chunks:      [],
  recording:   false,
  silenceTimer: null,
  rafId:       null,
  mimeType:    '',
};

async function initMediaRecorderFallback() {
  // Show the push-to-talk button (always visible as manual option)
  const pttBtn = $('ptt-btn');
  if (pttBtn) pttBtn.style.display = 'flex';

  // Request mic access
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (err) {
    console.error('[VAD] getUserMedia failed:', err);
    // Last resort: show text input
    $('text-input-fallback').classList.add('visible');
    setupTextInputFallback();
    showToast('Mic unavailable — use text input');
    return;
  }

  vad.stream   = stream;
  vad.mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
               : MediaRecorder.isTypeSupported('audio/webm')              ? 'audio/webm'
               : 'audio/ogg;codecs=opus';

  // Set up AudioContext analyser for Voice Activity Detection
  vad.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const src    = vad.audioCtx.createMediaStreamSource(stream);
  vad.analyser = vad.audioCtx.createAnalyser();
  vad.analyser.fftSize          = 512;
  vad.analyser.smoothingTimeConstant = 0.6;
  src.connect(vad.analyser);

  state.vadActive = true;
  $('mic-indicator').className = 'active';
  showToast('Auto-mic active (Quest mode)');
  runVAD();
}

const VAD_THRESHOLD     = 18;   // energy level that counts as speech
const VAD_SILENCE_MS    = 1200; // ms of silence before cutting a segment
const VAD_MIN_SPEECH_MS = 400;  // ignore very short bursts (< 0.4s)
const VAD_MAX_RECORD_MS = 12000;// safety cap per segment

function runVAD() {
  const data = new Uint8Array(vad.analyser.frequencyBinCount);

  function tick() {
    if (!state.vadActive) return;
    vad.rafId = requestAnimationFrame(tick);

    vad.analyser.getByteFrequencyData(data);
    // Focus on speech frequencies (~80 Hz – 3 kHz)
    const lo  = Math.floor(80  / (vad.audioCtx.sampleRate / vad.analyser.fftSize));
    const hi  = Math.floor(3000 / (vad.audioCtx.sampleRate / vad.analyser.fftSize));
    let   sum = 0;
    for (let i = lo; i <= hi; i++) sum += data[i];
    const avg = sum / (hi - lo + 1);

    if (avg > VAD_THRESHOLD) {
      // Voice detected
      $('mic-indicator').className = 'speaking';
      if (!vad.recording) startVADRecording();
      clearTimeout(vad.silenceTimer);
      vad.silenceTimer = setTimeout(stopVADRecording, VAD_SILENCE_MS);
    } else if (!vad.recording) {
      $('mic-indicator').className = 'active';
    }
  }
  tick();
}

function startVADRecording() {
  if (vad.recording) return;
  vad.recording = true;
  vad.chunks    = [];
  vad.recorder  = new MediaRecorder(vad.stream, { mimeType: vad.mimeType });

  vad.recorder.ondataavailable = (e) => { if (e.data.size > 0) vad.chunks.push(e.data); };
  vad.recorder.onstop          = onVADSegmentReady;
  vad.recorder.start(100); // collect data every 100ms

  // Safety: stop if recording runs too long
  vad.maxTimer = setTimeout(stopVADRecording, VAD_MAX_RECORD_MS);
}

function stopVADRecording() {
  if (!vad.recording || !vad.recorder) return;
  clearTimeout(vad.maxTimer);
  vad.recording = false;
  try { vad.recorder.stop(); } catch {}
  $('mic-indicator').className = 'active';
}

async function onVADSegmentReady() {
  if (!vad.chunks.length) return;
  const blob = new Blob(vad.chunks, { type: vad.mimeType });
  vad.chunks = [];

  // Ignore very short clips (likely noise)
  if (blob.size < 2000) return;

  showInterimCaption('Transcribing…');
  const text = await sendAudioForTranscription(blob, vad.mimeType);
  clearInterimCaption();

  if (text && text.trim().length > 1) {
    if (state.settings.captions) addCaptionLine(text, 'self');
    if (state.settings.topic)    feedTopicBuffer(text);
    if (!state.standalone)       wsSend({ type: 'speech', text: text.trim(), isFinal: true });
  }
}

async function sendAudioForTranscription(blob, mimeType) {
  try {
    const lang = (LANGUAGES[state.headsetLang]?.speech || 'en-US').split('-')[0];
    const res  = await fetch('/api/transcribe', {
      method:  'POST',
      headers: { 'Content-Type': mimeType, 'X-Lang': lang },
      body:    blob,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (err.error === 'no_key') {
        showToast('Set OPENAI_API_KEY on server for Quest mic');
      }
      return '';
    }
    const { text } = await res.json();
    return text || '';
  } catch (e) {
    console.error('[Transcribe]', e);
    return '';
  }
}

// Push-to-talk: manual recording (bypasses VAD, useful in noisy environments)
function setupPushToTalk() {
  const btn = $('ptt-btn');
  if (!btn) return;

  let pttRecorder = null;
  let pttChunks   = [];

  function startPTT() {
    if (!vad.stream) return;
    pttChunks   = [];
    pttRecorder = new MediaRecorder(vad.stream, { mimeType: vad.mimeType || 'audio/webm' });
    pttRecorder.ondataavailable = (e) => { if (e.data.size > 0) pttChunks.push(e.data); };
    pttRecorder.onstop = async () => {
      const blob = new Blob(pttChunks, { type: vad.mimeType || 'audio/webm' });
      pttChunks  = [];
      showInterimCaption('Transcribing…');
      const text = await sendAudioForTranscription(blob, vad.mimeType || 'audio/webm');
      clearInterimCaption();
      if (text?.trim()) {
        if (state.settings.captions) addCaptionLine(text, 'self');
        if (state.settings.topic)    feedTopicBuffer(text);
        if (!state.standalone)       wsSend({ type: 'speech', text: text.trim(), isFinal: true });
      }
    };
    pttRecorder.start();
    btn.classList.add('recording');
    btn.textContent = '⏹ Release';
    $('mic-indicator').className = 'speaking';
  }

  function stopPTT() {
    if (pttRecorder?.state === 'recording') pttRecorder.stop();
    btn.classList.remove('recording');
    btn.textContent = '🎙 Hold to Speak';
    $('mic-indicator').className = 'active';
  }

  btn.addEventListener('pointerdown', (e) => { e.preventDefault(); startPTT(); });
  btn.addEventListener('pointerup',   (e) => { e.preventDefault(); stopPTT();  });
  btn.addEventListener('pointerleave',(e) => { e.preventDefault(); stopPTT();  });
}

function stopVAD() {
  state.vadActive = false;
  cancelAnimationFrame(vad.rafId);
  clearTimeout(vad.silenceTimer);
  if (vad.recorder?.state === 'recording') { try { vad.recorder.stop(); } catch {} }
  if (vad.audioCtx) { try { vad.audioCtx.close(); } catch {} }
  if (vad.stream)   vad.stream.getTracks().forEach((t) => t.stop());
  vad.recording = false;
}

// ── Text input last-resort fallback ───────────────────────────────────────
function setupTextInputFallback() {
  const input = $('fallback-input');
  const send  = $('fallback-send');
  function submitText() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    if (state.settings.captions) addCaptionLine(text, 'self');
    if (state.settings.topic)    feedTopicBuffer(text);
    if (!state.standalone)       wsSend({ type: 'speech', text, isFinal: true });
  }
  send.addEventListener('click', submitText);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitText(); });
}

// ═══════════════════════════════════════════════════════════════════════════
// CAPTIONS
// ═══════════════════════════════════════════════════════════════════════════
const MAX_CAPTION_LINES = 4;
const CAPTION_TTL_MS    = 25_000;

function showInterimCaption(text) {
  if (!state.settings.captions) return;

  const container = $('captions-container');
  const placeholder = $('caption-placeholder');
  if (placeholder) placeholder.style.display = 'none';

  if (!state.interimEl) {
    state.interimEl = document.createElement('div');
    state.interimEl.className = 'caption-line caption-interim';
    container.appendChild(state.interimEl);
  }
  state.interimEl.textContent = text;
}

function clearInterimCaption() {
  if (state.interimEl) {
    state.interimEl.remove();
    state.interimEl = null;
  }
}

function addCaptionLine(text, type, subtext) {
  // type: 'self' (headset user) | 'other' (translated from phone)
  const container = $('captions-container');
  const placeholder = $('caption-placeholder');
  if (placeholder) placeholder.style.display = 'none';

  const line = document.createElement('div');
  line.className = `caption-line caption-${type}`;

  const speaker = document.createElement('span');
  speaker.className = 'caption-speaker';
  speaker.textContent = type === 'self' ? 'You' : (state.profile.name || 'Them');
  line.appendChild(speaker);
  line.appendChild(document.createTextNode(text));

  if (subtext) {
    const sub = document.createElement('span');
    sub.style.cssText = 'font-size:11px; opacity:0.45; margin-left:6px;';
    sub.textContent = subtext;
    line.appendChild(sub);
  }

  // Remove interim before adding final
  clearInterimCaption();

  container.appendChild(line);

  // Track for cleanup
  const timer = setTimeout(() => removeCaptionLine(entry), CAPTION_TTL_MS);
  const entry = { el: line, timer };
  state.captionLines.push(entry);

  // Keep max lines
  while (state.captionLines.length > MAX_CAPTION_LINES) {
    removeCaptionLine(state.captionLines[0]);
  }

  // Scroll to bottom
  container.scrollTop = container.scrollHeight;
}

function removeCaptionLine(entry) {
  clearTimeout(entry.timer);
  entry.el.classList.add('fading');
  setTimeout(() => {
    entry.el.remove();
    const idx = state.captionLines.indexOf(entry);
    if (idx > -1) state.captionLines.splice(idx, 1);
    // Show placeholder if empty
    if (state.captionLines.length === 0 && !state.interimEl) {
      const placeholder = $('caption-placeholder');
      if (placeholder) placeholder.style.display = '';
    }
  }, 500);
}

// ═══════════════════════════════════════════════════════════════════════════
// TOPIC DETECTION
// ═══════════════════════════════════════════════════════════════════════════
const TOPIC_BUFFER_WINDOW = 60_000; // 60 seconds
const TOPIC_DEBOUNCE_MS   = 2_000;

function feedTopicBuffer(text) {
  state.topicBuffer.push({ text, ts: Date.now() });
  // Prune old entries
  const cutoff = Date.now() - TOPIC_BUFFER_WINDOW;
  state.topicBuffer = state.topicBuffer.filter((e) => e.ts > cutoff);

  clearTimeout(state.topicTimer);
  state.topicTimer = setTimeout(refreshTopic, TOPIC_DEBOUNCE_MS);
}

function refreshTopic() {
  if (!state.settings.topic) return;

  const combined = state.topicBuffer.map((e) => e.text).join(' ');
  const words    = combined.toLowerCase().split(/\W+/).filter((w) => w.length > 2);

  let best = { topic: null, icon: '💬', score: 0 };
  for (const [topic, { icon, words: kw }] of Object.entries(TOPICS)) {
    const score = words.filter((w) => kw.includes(w)).length;
    if (score > best.score) best = { topic, icon, score };
  }

  const detected = best.score >= 2 ? best.topic : null;

  if (detected && detected !== state.currentTopic) {
    state.currentTopic = detected;
    $('topic-value').textContent = detected;
    $('topic-icon').textContent  = best.icon;
    $('topic-panel').classList.add('visible');
  } else if (!detected) {
    $('topic-panel').classList.remove('visible');
    state.currentTopic = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// WEBXR
// ═══════════════════════════════════════════════════════════════════════════
async function checkXRSupport() {
  if (!navigator.xr) {
    console.log('[XR] WebXR not available — running in browser mode.');
    $('enter-ar-btn').textContent   = '🖥️ Open in Browser Mode';
    $('enter-ar-btn').disabled      = false;
    return;
  }

  try {
    state.xrSupported = await navigator.xr.isSessionSupported('immersive-ar');
  } catch {
    state.xrSupported = false;
  }

  if (state.xrSupported) {
    $('enter-ar-btn').disabled = !state.phoneConnected && !state.standalone;
  } else {
    console.log('[XR] immersive-ar not supported — browser fallback mode.');
    $('enter-ar-btn').textContent = '🖥️ Open in Browser Mode';
    $('enter-ar-btn').disabled   = false;
  }
}

async function enterAR() {
  const overlayRoot = $('ar-overlay');

  // ── CRITICAL: the dom-overlay root MUST be in the render tree (display:block)
  // before requestSession() is called. Quest Browser rejects the session if the
  // root element is hidden (display:none), which was causing the black screen.
  overlayRoot.style.display    = 'block';
  overlayRoot.style.visibility = 'hidden'; // in layout but not painted yet

  if (!state.xrSupported || !navigator.xr) {
    $('setup-screen').style.display  = 'none';
    overlayRoot.style.visibility     = 'visible';
    document.body.classList.add('xr-active');
    startListening();
    return;
  }

  try {
    state.xrSession = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['dom-overlay'],
      domOverlay:       { root: overlayRoot },
    });
  } catch (err) {
    console.error('[XR] Session failed:', err.name, err.message);
    showToast(`AR failed (${err.name}) — browser mode`);
    $('setup-screen').style.display  = 'none';
    overlayRoot.style.visibility     = 'visible';
    document.body.classList.add('xr-active');
    startListening();
    return;
  }

  state.xrSession.addEventListener('end', onXRSessionEnd);

  // Set up minimal WebGL layer
  // Canvas must exist in DOM but doesn't need to be visible.
  // Position off-screen so it doesn't flash over the UI.
  const canvas = $('xr-canvas');
  canvas.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;';
  canvas.style.display = 'block';

  // alpha:true + premultipliedAlpha:false are REQUIRED for transparent
  // passthrough on Meta Quest 3 — without them the framebuffer is opaque black.
  const ctxAttribs = { xrCompatible: true, alpha: true, premultipliedAlpha: false };
  state.gl = canvas.getContext('webgl2', ctxAttribs)
           || canvas.getContext('webgl',  ctxAttribs);

  if (!state.gl) {
    showToast('WebGL not available');
    state.xrSession.end();
    return;
  }

  try {
    await state.gl.makeXRCompatible();
  } catch (e) {
    console.warn('[XR] makeXRCompatible failed:', e);
  }

  // alpha:true on the layer tells the XR compositor to blend with passthrough.
  // antialias:false saves GPU bandwidth — we only need a transparent framebuffer.
  const baseLayer = new XRWebGLLayer(state.xrSession, state.gl, {
    alpha:      true,
    antialias:  false,
    depth:      true,
    stencil:    false,
  });
  state.xrSession.updateRenderState({ baseLayer });

  let refSpace;
  try {
    refSpace = await state.xrSession.requestReferenceSpace('local');
  } catch {
    refSpace = await state.xrSession.requestReferenceSpace('viewer');
  }

  // Show AR overlay, hide setup.
  // Force ALL backgrounds transparent so passthrough shows through.
  $('setup-screen').style.display            = 'none';
  overlayRoot.style.visibility               = 'visible';
  overlayRoot.style.background               = 'transparent';
  document.documentElement.style.background  = 'transparent';
  document.body.style.background             = 'transparent';
  document.body.classList.add('xr-active');

  // Minimal render loop — just clear each frame (passthrough handles background)
  state.xrSession.requestAnimationFrame(function xrFrame(time, frame) {
    if (!state.xrSession) return;
    state.xrSession.requestAnimationFrame(xrFrame);

    const layer = state.xrSession.renderState.baseLayer;
    state.gl.bindFramebuffer(state.gl.FRAMEBUFFER, layer.framebuffer);
    state.gl.clearColor(0, 0, 0, 0);
    state.gl.clear(state.gl.COLOR_BUFFER_BIT | state.gl.DEPTH_BUFFER_BIT);
  });

  startListening();
}

function onXRSessionEnd() {
  state.xrSession = null;
  state.gl        = null;
  document.body.classList.remove('xr-active');
  document.body.style.background = '';
  $('ar-overlay').style.display   = 'none';
  $('setup-screen').style.display = 'flex';
  $('xr-canvas').style.display    = 'none';
  stopListening();
}

function exitAR() {
  if (state.xrSession) {
    state.xrSession.end();
  } else {
    // Browser fallback mode
    document.body.classList.remove('xr-active');
    $('ar-overlay').style.display   = 'none';
    $('setup-screen').style.display = 'flex';
    stopListening();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// UI HANDLERS
// ═══════════════════════════════════════════════════════════════════════════
function setupUIHandlers() {
  // Language changes
  $('headset-lang').addEventListener('change', (e) => {
    state.headsetLang = e.target.value;
    localStorage.setItem('headsetLang', state.headsetLang);
    if (state.recognition) {
      state.recognition.lang = LANGUAGES[state.headsetLang]?.speech || 'en-US';
    }
    if (state.roomCode) {
      wsSend({ type: 'update_lang', lang: state.headsetLang });
    }
    if (state.isListening) restartRecognition();
  });

  $('phone-lang-setup').addEventListener('change', (e) => {
    state.phoneLang = e.target.value;
    localStorage.setItem('phoneLang', state.phoneLang);
    if (state.roomCode) {
      wsSend({ type: 'update_lang', lang: state.phoneLang });
    }
  });

  // Enter AR
  $('enter-ar-btn').addEventListener('click', () => {
    state.standalone = false;
    enterAR();
  });

  // Standalone mode
  $('standalone-btn').addEventListener('click', () => {
    state.standalone = true;
    $('enter-ar-btn').disabled = false;
    enterAR();
  });

  // Settings toggles
  $('toggle-captions').addEventListener('change', (e) => {
    state.settings.captions = e.target.checked;
    if (!e.target.checked) {
      // Clear captions
      clearAllCaptions();
    }
  });

  $('toggle-topic').addEventListener('change', (e) => {
    state.settings.topic = e.target.checked;
    if (!e.target.checked) {
      $('topic-panel').classList.remove('visible');
    } else {
      refreshTopic();
    }
  });

  $('toggle-haptics').addEventListener('change', (e) => {
    state.settings.haptics = e.target.checked;
  });

  // Exit AR (inline button in settings)
  $('exit-ar-btn-inline').addEventListener('click', exitAR);

  // Mic indicator click (toggle mute)
  $('mic-indicator').addEventListener('click', () => {
    if (state.isListening) {
      stopListening();
      showToast('Microphone muted');
    } else {
      startListening();
      showToast('Microphone active');
    }
  });
}

function clearAllCaptions() {
  state.captionLines.forEach((e) => {
    clearTimeout(e.timer);
    e.el.remove();
  });
  state.captionLines = [];
  clearInterimCaption();
  const placeholder = $('caption-placeholder');
  if (placeholder) placeholder.style.display = '';
}

// ═══════════════════════════════════════════════════════════════════════════
// UI DISPLAY HELPERS
// ═══════════════════════════════════════════════════════════════════════════
function updateRoomCodeDisplay(code) {
  $('setup-room-code').textContent  = code;
  $('conn-code-display').textContent = code;

  // Generate QR for the phone URL
  const phoneUrl = `${location.origin}/phone.html?room=${code}`;
  const qrUrl    = `https://api.qrserver.com/v1/create-qr-code/?size=80x80&color=ffffff&bgcolor=0a0c18&data=${encodeURIComponent(phoneUrl)}`;
  const qrImg    = $('qr-img');
  qrImg.src      = qrUrl;
  qrImg.style.display = 'block';
}

function updatePhoneUrlHint() {
  const hint = $('phone-url-hint');
  if (hint) hint.textContent = `${location.host}/phone.html`;
}

function updateConnectionUI(connected) {
  const dot  = $('conn-dot');
  const text = $('conn-text');

  if (state.standalone) {
    dot.className  = 'conn-dot standalone';
    text.textContent = 'Standalone Mode';
    return;
  }

  if (connected) {
    dot.className  = 'conn-dot connected';
    text.textContent = state.profile.name
      ? `Connected · ${state.profile.name}`
      : 'Phone Connected';
  } else {
    dot.className  = 'conn-dot';
    text.textContent = 'Waiting for phone';
  }
}

function updateProfileDisplay(profile) {
  state.profile = { ...state.profile, ...profile };

  const name         = profile.name         || '';
  const relationship = profile.relationship || '';
  const lang         = profile.phoneLang    || state.phoneLang;

  const nameEl = $('ar-profile-name');
  const relEl  = $('ar-profile-relationship');
  const langEl = $('ar-profile-lang');
  const avatar = $('profile-avatar');

  if (name) {
    nameEl.textContent = name;
    nameEl.classList.remove('empty');
    avatar.textContent = name.charAt(0).toUpperCase();
  } else {
    nameEl.textContent = 'Connected';
    nameEl.classList.add('empty');
    avatar.textContent = '?';
  }

  if (relationship) {
    relEl.textContent = relationship;
    relEl.classList.remove('empty');
  } else {
    relEl.textContent = '—';
    relEl.classList.add('empty');
  }

  const langInfo = LANGUAGES[lang];
  langEl.textContent = langInfo ? `${langInfo.flag} ${langInfo.name}` : lang;
}

function resetProfileDisplay() {
  $('ar-profile-name').textContent = 'Not Connected';
  $('ar-profile-name').classList.add('empty');
  $('ar-profile-relationship').textContent = '—';
  $('ar-profile-relationship').classList.add('empty');
  $('ar-profile-lang').textContent = '—';
  $('profile-avatar').textContent  = '?';
}

// ═══════════════════════════════════════════════════════════════════════════
// HAPTICS
// ═══════════════════════════════════════════════════════════════════════════
function triggerHaptic(intensity) {
  if (!state.settings.haptics) return;
  if (!navigator.vibrate) return;
  const patterns = { light: [30], medium: [50, 30, 50], heavy: [100, 50, 100] };
  navigator.vibrate(patterns[intensity] || patterns.light);
}

// ═══════════════════════════════════════════════════════════════════════════
// TOAST NOTIFICATION
// ═══════════════════════════════════════════════════════════════════════════
let toastTimer = null;
function showToast(msg, duration = 2500) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}
