const $ = (id) => document.getElementById(id);

const PRESETS = {
  talk:    { gain: 1.5, maxAgc: 4, transient: 0.6, gate: -50, nr: 0.50, presence: 4, hp: 100 },
  tv:      { gain: 1.2, maxAgc: 3, transient: 0.5, gate: -55, nr: 0.70, presence: 6, hp: 80  },
  outside: { gain: 2.0, maxAgc: 5, transient: 0.8, gate: -45, nr: 0.80, presence: 5, hp: 150 },
};

const params = { ...PRESETS.talk, deEss: true };
try { Object.assign(params, JSON.parse(localStorage.getItem('sluh_params') || '{}')); } catch {}

let ctx = null, stream = null, src = null, hp = null, presence = null,
    worklet = null, analyser = null, wakeLock = null;
let micId = localStorage.getItem('sluh_mic') || '';
let asr = null, asrEnabled = params.asrEnabled !== false;
let running = false;
let lastFinalText = '';

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ---------- SpeechRecognition ----------
function initASR() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const r = new SR();
  r.lang = 'ru-RU';
  r.continuous = true;
  r.interimResults = true;
  r.maxAlternatives = 1;
  r.onresult = (e) => {
    let interim = '';
    let finalBatch = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) finalBatch += res[0].transcript;
      else interim += res[0].transcript;
    }
    if (interim) $('subtitleInterim').textContent = interim;
    if (finalBatch) {
      $('subtitleInterim').textContent = '';
      const el = document.createElement('p');
      el.textContent = finalBatch;
      $('subtitleFinal').appendChild(el);
      // Ограничиваем историю
      while ($('subtitleFinal').children.length > 30)
        $('subtitleFinal').removeChild($('subtitleFinal').firstChild);
      $('subtitles').scrollTop = $('subtitles').scrollHeight;
      lastFinalText = finalBatch;
    }
  };
  r.onerror = (e) => console.warn('ASR:', e.error);
  r.onend = () => { if (running && asrEnabled && asr) try { r.start(); } catch {} };
  return r;
}

function startASR() {
  if (!asrEnabled) return;
  if (!asr) asr = initASR();
  if (!asr) return;
  try { asr.start(); } catch {}
}

function stopASR() {
  if (asr) try { asr.stop(); } catch {}
}

$('asrToggle').onchange = (e) => {
  asrEnabled = e.target.checked;
  params.asrEnabled = asrEnabled;
  save();
  if (asrEnabled && running) startASR();
  if (!asrEnabled) { stopASR(); $('subtitleInterim').textContent = ''; }
};

// ---------- Слайдеры ----------
const FMT = {
  gain: v => v.toFixed(1) + '×',
  maxAgc: v => v.toFixed(1) + '×',
  nr: v => v.toFixed(2),
  transient: v => v.toFixed(2),
  gate: v => Math.round(v) + ' dB',
  presence: v => (v >= 0 ? '+' : '') + v.toFixed(1) + ' dB',
  hp: v => Math.round(v) + ' Гц',
};

function bindSlider(id) {
  const el = $(id), out = $(id + 'Val');
  el.value = params[id];
  out.textContent = FMT[id](params[id]);
  el.oninput = () => {
    params[id] = parseFloat(el.value);
    out.textContent = FMT[id](params[id]);
    applyLive();
    save();
  };
}
['gain','maxAgc','nr','transient','gate','presence','hp'].forEach(bindSlider);

$('deEssToggle').checked = params.deEss;
$('deEssToggle').onchange = (e) => {
  params.deEss = e.target.checked;
  applyLive(); save();
};

function save() { localStorage.setItem('sluh_params', JSON.stringify(params)); }

function applyLive() {
  if (worklet) {
    worklet.port.postMessage({
      type: 'params',
      gain: params.gain, maxAgc: params.maxAgc, gate: params.gate,
      transient: params.transient, nr: params.nr, nrEnabled: params.nr > 0,
      deEss: params.deEss,
    });
  }
  if (hp) hp.frequency.value = params.hp;
  if (presence) presence.gain.value = params.presence;
}

// ---------- Пресеты ----------
document.querySelectorAll('.preset').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.preset').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    Object.assign(params, PRESETS[btn.dataset.preset]);
    ['gain','maxAgc','nr','transient','gate','presence','hp'].forEach(k => {
      $(k).value = params[k];
      $(k + 'Val').textContent = FMT[k](params[k]);
    });
    applyLive(); save();
  };
});

// ---------- Микрофоны ----------
const BT_RE = /bluetooth|headset|hands.?free|buds|airpods|headphone|наушник|гарнитур|free\s*hands/i;
const isBTMic = (d) => BT_RE.test(d.label || '');

async function ensurePermission() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach(t => t.stop());
  } catch {}
}

async function listMics() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter(d => d.kind === 'audioinput');
  } catch { return []; }
}

async function refreshMicList() {
  let mics = await listMics();
  // Если метки пустые — попросить разрешение
  if (mics.length && !mics[0].label) {
    await ensurePermission();
    mics = await listMics();
  }
  const sel = $('micSelect');
  sel.innerHTML = '';
  if (!mics.length) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = 'Нет доступных микрофонов';
    sel.appendChild(o);
    return;
  }
  // Лучший микрофон по умолчанию — не-BT
  let bestId = mics.find(d => !isBTMic(d))?.deviceId || mics[0].deviceId;
  if (micId && mics.some(d => d.deviceId === micId)) bestId = micId;

  mics.forEach(d => {
    const o = document.createElement('option');
    o.value = d.deviceId;
    const isBT = isBTMic(d);
    const label = d.label || `Микрофон ${d.deviceId.slice(0, 6)}`;
    o.textContent = isBT ? `🎧 ${label} (не рекомендуется)` : `🎤 ${label}`;
    if (d.deviceId === bestId) o.selected = true;
    sel.appendChild(o);
  });
  micId = bestId;
  updateMicWarning();
}

function updateMicWarning() {
  const sel = $('micSelect');
  const opt = sel.options[sel.selectedIndex];
  const warn = opt && /🎧/.test(opt.textContent);
  $('micWarning').hidden = !warn;
}

$('micSelect').onchange = async (e) => {
  micId = e.target.value;
  localStorage.setItem('sluh_mic', micId);
  updateMicWarning();
  if (running) { await stop(); await start(); }
};

// Переключение при изменении устройств
navigator.mediaDevices?.addEventListener?.('devicechange', async () => {
  await refreshMicList();
});

// ---------- Старт / стоп ----------
$('startBtn').onclick = start;
$('stopBtn').onclick = stop;

async function start() {
  try {
    $('status').textContent = 'Запрос доступа к микрофону…';
    await ensurePermission();
    if (!micId) await refreshMicList();

    const audioConstraints = {
      channelCount: 1,
      echoCancellation: true,   // системный AEC — гасит остаточную петлю
      noiseSuppression: false,  // свой NR
      autoGainControl: false,   // свой AGC
    };
    if (micId) audioConstraints.deviceId = { ideal: micId };

    stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });

    // Проверка фактического устройства
    const s = stream.getAudioTracks()[0].getSettings();
    const actualSR = s.sampleRate || 0;
    const actualId = s.deviceId || '';

    ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: actualSR || 48000 });
    if (ctx.state === 'suspended') await ctx.resume();
    await ctx.audioWorklet.addModule('processor.js');

    src = ctx.createMediaStreamSource(stream);

    hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = params.hp; hp.Q.value = 0.7;

    presence = ctx.createBiquadFilter();
    presence.type = 'peaking'; presence.frequency.value = 2800;
    presence.Q.value = 1.0; presence.gain.value = params.presence;

    worklet = new AudioWorkletNode(ctx, 'listen-processor', {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
    });
    worklet.port.onmessage = (e) => {
      if (e.data.type === 'vad') {
        $('vadDot').classList.toggle('active', e.data.active);
        $('vadText').textContent = e.data.active ? 'Слышу речь' : 'Тишина';
      }
    };
    applyLive();

    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.7;

    src.connect(hp);
    hp.connect(presence);
    presence.connect(worklet);
    worklet.connect(analyser);
    worklet.connect(ctx.destination);

    try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch {}

    drawMeter();
    drawWaveform();
    drawSpectrum();

    running = true;
    $('startBtn').disabled = true;
    $('stopBtn').disabled = false;
    $('status').textContent =
      `Микрофон: ${$('micSelect').selectedOptions[0]?.textContent || '—'} · ${actualSR} Гц`;

    if (asrEnabled) startASR();
  } catch (e) {
    console.error(e);
    $('status').textContent = 'Ошибка: ' + e.message;
  }
}

async function stop() {
  stopASR();
  try {
    worklet?.disconnect(); presence?.disconnect(); hp?.disconnect();
    src?.disconnect(); analyser?.disconnect();
    stream?.getTracks().forEach(t => t.stop());
    await ctx?.close();
    if (wakeLock) { await wakeLock.release().catch(() => {}); wakeLock = null; }
  } catch {}
  ctx = worklet = src = stream = analyser = null;
  running = false;
  $('startBtn').disabled = false;
  $('stopBtn').disabled = true;
  $('status').textContent = 'Остановлено.';
  $('vadDot').classList.remove('active');
  $('vadText').textContent = 'Ожидание';
  $('meterFill').style.width = '0%';
}

// ---------- Визуализация ----------
function drawMeter() {
  if (!analyser) return;
  const buf = new Uint8Array(analyser.fftSize);
  const loop = () => {
    if (!analyser) return;
    analyser.getByteTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = Math.abs(buf[i] - 128);
      if (v > peak) peak = v;
    }
    const fill = $('meterFill');
    fill.style.width = Math.min(100, peak / 128 * 100) + '%';
    fill.style.background = peak > 120 ? '#da3633' : peak > 80 ? '#d29922' : '#2ea043';
    requestAnimationFrame(loop);
  };
  loop();
}

function drawWaveform() {
  const cv = $('waveform');
  const g = cv.getContext('2d');
  const buf = new Uint8Array(analyser.fftSize);
  const loop = () => {
    if (!analyser) return;
    const w = cv.width = cv.clientWidth * devicePixelRatio;
    const h = cv.height = cv.clientHeight * devicePixelRatio;
    analyser.getByteTimeDomainData(buf);
    g.fillStyle = '#0d1117'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#388bfd'; g.lineWidth = 2 * devicePixelRatio;
    g.beginPath();
    const step = buf.length / w;
    for (let x = 0; x < w; x++) {
      const v = buf[Math.floor(x * step)] / 128;
      const y = h / 2 + (v - 1) * h / 2 * 0.9;
      x === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
    }
    g.stroke();
    requestAnimationFrame(loop);
  };
  loop();
}

function drawSpectrum() {
  const cv = $('spectrum');
  const g = cv.getContext('2d');
  const buf = new Uint8Array(analyser.frequencyBinCount);
  const loop = () => {
    if (!analyser) return;
    const w = cv.width = cv.clientWidth * devicePixelRatio;
    const h = cv.height = cv.clientHeight * devicePixelRatio;
    analyser.getByteFrequencyData(buf);
    g.fillStyle = '#0d1117'; g.fillRect(0, 0, w, h);
    // Логарифмическая ось: 100 Гц .. 8 кГц
    const sr = ctx.sampleRate;
    const nyq = sr / 2;
    const binCount = buf.length;
    g.fillStyle = '#2ea043';
    const bars = 96;
    for (let x = 0; x < bars; x++) {
      const f1 = 100 * Math.pow(8000 / 100, x / bars);
      const f2 = 100 * Math.pow(8000 / 100, (x + 1) / bars);
      const b1 = Math.floor(f1 / nyq * binCount);
      const b2 = Math.max(b1 + 1, Math.floor(f2 / nyq * binCount));
      let v = 0;
      for (let b = b1; b < b2 && b < binCount; b++) v = Math.max(v, buf[b]);
      const hh = v / 255 * h * 0.9;
      g.fillRect(x * (w / bars), h - hh, (w / bars) - 1, hh);
    }
    requestAnimationFrame(loop);
  };
  loop();
}

// ---------- Init ----------
refreshMicList();
if (!window.SpeechRecognition && !window.webkitSpeechRecognition) {
  $('asrToggle').disabled = true;
  $('asrToggle').checked = false;
  asrEnabled = false;
}