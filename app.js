const $ = (id) => document.getElementById(id);

const PRESETS = {
  talk:    { gain: 1.5, maxAgc: 4, transient: 0.6, gate: -50, nr: 0.50, presence: 4, hp: 100 },
  tv:      { gain: 1.2, maxAgc: 3, transient: 0.5, gate: -55, nr: 0.70, presence: 6, hp: 80  },
  outside: { gain: 2.0, maxAgc: 5, transient: 0.8, gate: -45, nr: 0.80, presence: 5, hp: 150 },
};

const params = { ...PRESETS.talk };
try { Object.assign(params, JSON.parse(localStorage.getItem('sluh_params') || '{}')); } catch {}

let ctx = null, stream = null, src = null, hp = null, presence = null,
    worklet = null, analyser = null, wakeLock = null;

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

const FMT = {
  gain: v => v.toFixed(1) + '×',
  maxAgc: v => v.toFixed(1) + '×',
  nr: v => v.toFixed(2),
  transient: v => v.toFixed(2),
  gate: v => Math.round(v) + ' dB',
  presence: v => (v >= 0 ? '+' : '') + v.toFixed(1) + ' dB',
  hp: v => Math.round(v) + ' Гц',
};

function bindSlider(id, key) {
  const el = $(id), out = $(id + 'Val');
  el.value = params[key];
  out.textContent = FMT[key](params[key]);
  el.oninput = () => {
    params[key] = parseFloat(el.value);
    out.textContent = FMT[key](params[key]);
    applyLive();
    save();
  };
}

['gain', 'maxAgc', 'nr', 'transient', 'gate', 'presence', 'hp'].forEach(k => bindSlider(k, k));

function save() { localStorage.setItem('sluh_params', JSON.stringify(params)); }

function applyLive() {
  if (worklet) {
    worklet.port.postMessage({
      type: 'params',
      gain: params.gain,
      maxAgc: params.maxAgc,
      gate: params.gate,
      transient: params.transient,
      nr: params.nr,
      nrEnabled: params.nr > 0,
    });
  }
  if (hp) hp.frequency.value = params.hp;
  if (presence) presence.gain.value = params.presence;
}

document.querySelectorAll('.preset').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.preset').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    Object.assign(params, PRESETS[btn.dataset.preset]);
    ['gain', 'maxAgc', 'nr', 'transient', 'gate', 'presence', 'hp'].forEach(k => {
      const el = $(k);
      if (el) {
        el.value = params[k];
        $(k + 'Val').textContent = FMT[k](params[k]);
      }
    });
    applyLive();
    save();
  };
});

$('startBtn').onclick = start;
$('stopBtn').onclick = stop;

async function start() {
  try {
    $('status').textContent = 'Запрос доступа к микрофону…';
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') await ctx.resume();
    await ctx.audioWorklet.addModule('processor.js');

    src = ctx.createMediaStreamSource(stream);

    hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = params.hp;
    hp.Q.value = 0.7;

    presence = ctx.createBiquadFilter();
    presence.type = 'peaking';
    presence.frequency.value = 2800;
    presence.Q.value = 1.0;
    presence.gain.value = params.presence;

    worklet = new AudioWorkletNode(ctx, 'listen-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    applyLive();

    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;

    src.connect(hp);
    hp.connect(presence);
    presence.connect(worklet);
    worklet.connect(analyser);
    worklet.connect(ctx.destination);

    try {
      if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    } catch {}

    drawMeter();
    $('startBtn').disabled = true;
    $('stopBtn').disabled = false;
    $('status').textContent = 'Работает. Говорите по очереди — приложение подстроится.';
  } catch (e) {
    console.error(e);
    $('status').textContent = 'Ошибка: ' + e.message;
  }
}

async function stop() {
  try {
    worklet?.disconnect();
    presence?.disconnect();
    hp?.disconnect();
    src?.disconnect();
    analyser?.disconnect();
    stream?.getTracks().forEach(t => t.stop());
    await ctx?.close();
    if (wakeLock) { await wakeLock.release().catch(() => {}); wakeLock = null; }
  } catch {}
  ctx = worklet = src = stream = null;
  $('startBtn').disabled = false;
  $('stopBtn').disabled = true;
  $('status').textContent = 'Остановлено.';
}

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
    fill.style.width = Math.min(100, (peak / 128) * 100) + '%';
    fill.style.background = peak > 120 ? '#da3633' : peak > 80 ? '#d29922' : '#2ea043';
    if (analyser) requestAnimationFrame(loop);
  };
  loop();
}