// ListenBoost v0.2 — AudioWorklet DSP
// Реальное спектральное шумоподавление: STFT + minimum statistics + Wiener
//
// Конвейер:
//   1. Буферизация: N=512, hop=256, окно sqrt(Hann) — COLA
//   2. FFT → спектр мощности
//   3. Оценка шума по бину: minimum tracking + bias correction
//   4. Wiener-усиление с over-subtraction, сглаживание, spectral floor
//   5. IFFT → synthesis window → overlap-add
//   6. Per-sample: transient limiter, noise gate, AGC, master gain, лимитер

class ListenProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.N = 512;
    this.hop = 256;
    this.nBins = this.N / 2 + 1;
    const sr = sampleRate;
    const fps = sr / this.hop; // ~187.5 кадров/сек

    // sqrt(Hann) — COLA при H=N/2: w_a * w_s = Hann, sum = 1
    this.window = new Float32Array(this.N);
    for (let i = 0; i < this.N; i++) {
      const h = 0.5 * (1 - Math.cos((2 * Math.PI * i) / this.N));
      this.window[i] = Math.sqrt(Math.max(h, 1e-8));
    }

    // Буферы анализа/синтеза
    this.inBuf = new Float32Array(this.N);
    this.hopBuf = new Float32Array(this.hop);
    this.outBuf = new Float32Array(this.N);
    this.olaTemp = new Float32Array(this.N);
    this.hopPos = 0;

    // FFT scratch
    this.re = new Float32Array(this.N);
    this.im = new Float32Array(this.N);
    this.cos = new Float32Array(this.N);
    this.sin = new Float32Array(this.N);
    for (let i = 0; i < this.N; i++) {
      const ang = (-2 * Math.PI * i) / this.N;
      this.cos[i] = Math.cos(ang);
      this.sin[i] = Math.sin(ang);
    }
    // Таблица бит-реверса
    this.bitrev = new Uint16Array(this.N);
    const logN = Math.log2(this.N);
    for (let i = 0; i < this.N; i++) {
      let r = 0;
      for (let b = 0; b < logN; b++) r = (r << 1) | ((i >> b) & 1);
      this.bitrev[i] = r;
    }

    // Состояние шумоподавления (per-bin)
    this.smoothP = new Float32Array(this.nBins);
    this.minP = new Float32Array(this.nBins).fill(1e10);
    this.minCount = new Uint16Array(this.nBins);
    this.noiseP = new Float32Array(this.nBins).fill(1e-10);
    this.smoothGain = new Float32Array(this.nBins).fill(1);
    this.minResetPeriod = 400; // ~2.1 с при hop=256, 48кГц

    // Параметры, управляемые из UI
    this.gainMaster = 1.5;
    this.maxAgc = 4;
    this.gateDb = -50;
    this.transient = 0.6;
    this.nrStrength = 0.5;   // 0..1; 0 = bypass
    this.nrEnabled = true;

    // Огибающие (per-sample)
    this.fastEnv = 0;
    this.slowEnv = 1e-4;
    this.transGain = 1;
    this.gateEnv = 1;

    // AGC (per-hop)
    this.agcEnv = 1e-3;
    this.agcGain = 1;

    // Коэффициенты сглаживания
    this.aFastA = Math.exp(-1 / (0.002 * sr));
    this.aFastR = Math.exp(-1 / (0.080 * sr));
    this.aSlowA = Math.exp(-1 / (0.200 * sr));
    this.aSlowR = Math.exp(-1 / (0.400 * sr));
    this.aAgcEnv  = Math.exp(-1 / (0.6 * fps));
    this.aAgcGain = Math.exp(-1 / (0.1 * fps));
    this.aGate = Math.exp(-1 / (0.1 * sr));
    this.aTrans = Math.exp(-1 / (0.02 * sr));

    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.type !== 'params') return;
      if (d.gain !== undefined) this.gainMaster = d.gain;
      if (d.maxAgc !== undefined) this.maxAgc = d.maxAgc;
      if (d.gate !== undefined) this.gateDb = d.gate;
      if (d.transient !== undefined) this.transient = d.transient;
      if (d.nr !== undefined) this.nrStrength = d.nr;
      if (d.nrEnabled !== undefined) this.nrEnabled = d.nrEnabled;
    };
  }

  // ---------- FFT ----------
  fft(re, im) {
    const N = this.N;
    const bitrev = this.bitrev;

    for (let i = 0; i < N; i++) {
      const j = bitrev[i];
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }

    const cos = this.cos, sin = this.sin;
    for (let len = 2; len <= N; len <<= 1) {
      const half = len >> 1;
      const step = N / len;
      for (let i = 0; i < N; i += len) {
        for (let k = 0; k < half; k++) {
          const tw = k * step;
          const wRe = cos[tw], wIm = sin[tw];
          const a = i + k, b = a + half;
          const tRe = wRe * re[b] - wIm * im[b];
          const tIm = wRe * im[b] + wIm * re[b];
          re[b] = re[a] - tRe;
          im[b] = im[a] - tIm;
          re[a] += tRe;
          im[a] += tIm;
        }
      }
    }
  }

  ifft(re, im) {
    const N = this.N;
    for (let i = 0; i < N; i++) im[i] = -im[i];
    this.fft(re, im);
    for (let i = 0; i < N; i++) {
      re[i] /= N;
      im[i] = -im[i] / N;
    }
  }

  // ---------- Обработка кадра ----------
  processFrame() {
    const N = this.N;
    const re = this.re, im = this.im, win = this.window;

    for (let i = 0; i < N; i++) {
      re[i] = this.inBuf[i] * win[i];
      im[i] = 0;
    }
    this.fft(re, im);

    const nBins = this.nBins;
    const nrActive = this.nrEnabled && this.nrStrength > 0;

    if (nrActive) {
      const alpha = 1 + this.nrStrength * 3;         // over-subtraction 1..4
      const floor = Math.max(0.02, 0.1 - this.nrStrength * 0.08);

      for (let k = 0; k < nBins; k++) {
        const xr = re[k], xi = im[k];
        const power = xr * xr + xi * xi;

        // Сглаживание мощности
        this.smoothP[k] = 0.7 * this.smoothP[k] + 0.3 * power;

        // Minimum tracking
        if (this.smoothP[k] < this.minP[k]) {
          this.minP[k] = this.smoothP[k];
          this.minCount[k] = 0;
        } else {
          this.minCount[k]++;
          if (this.minCount[k] > this.minResetPeriod) {
            this.minP[k] = this.smoothP[k];
            this.minCount[k] = 0;
          }
        }

        // Оценка шума (bias correction ~1.5 для chi-square)
        const noiseEst = Math.max(this.minP[k] * 1.5, 1e-10);
        this.noiseP[k] = 0.9 * this.noiseP[k] + 0.1 * noiseEst;

        // Wiener с over-subtraction
        const snrPost = Math.max(0, power - alpha * this.noiseP[k])
                        / (this.noiseP[k] + 1e-10);
        let g = snrPost / (1 + snrPost);
        if (g < floor) g = floor;

        // Межкадровое сглаживание усиления
        this.smoothGain[k] = 0.6 * this.smoothGain[k] + 0.4 * g;

        re[k] = xr * this.smoothGain[k];
        im[k] = xi * this.smoothGain[k];
      }
    }

    // Восстановление эрмитова спектра
    for (let k = 1; k < N / 2; k++) {
      re[N - k] = re[k];
      im[N - k] = -im[k];
    }
    im[0] = 0;
    im[N / 2] = 0;

    this.ifft(re, im);

    // Синтез-окно (sqrt Hann) → olaTemp
    for (let i = 0; i < N; i++) {
      this.olaTemp[i] = re[i] * win[i];
    }

    // AGC — раз в кадр по RMS olaTemp (после шумоподавления)
    let sum = 0;
    for (let i = 0; i < N; i++) sum += this.olaTemp[i] * this.olaTemp[i];
    const rms = Math.sqrt(sum / N);
    this.agcEnv = this.aAgcEnv * this.agcEnv + (1 - this.aAgcEnv) * Math.max(rms, 1e-4);
    let agcTarget = 0.12 / this.agcEnv;
    if (agcTarget < 0.6) agcTarget = 0.6;
    if (agcTarget > this.maxAgc) agcTarget = this.maxAgc;
    this.agcGain = this.aAgcGain * this.agcGain + (1 - this.aAgcGain) * agcTarget;
  }

  // ---------- Per-sample ----------
  process(inputs, outputs) {
    const inp = inputs[0];
    const out = outputs[0][0];
    if (!inp || !inp.length) { out.fill(0); return true; }

    const n = out.length;
    const N = this.N;
    const hop = this.hop;
    const ch = inp.length;
    const gateLin = Math.pow(10, this.gateDb / 20);

    for (let i = 0; i < n; i++) {
      let x = 0;
      for (let c = 0; c < ch; c++) x += inp[c][i];
      x /= ch;

      this.hopBuf[this.hopPos] = x;
      let y = this.outBuf[this.hopPos];
      this.hopPos++;

      if (this.hopPos >= hop) {
        this.hopPos = 0;
        // Сдвиг анализа
        this.inBuf.copyWithin(0, hop);
        this.inBuf.set(this.hopBuf, N - hop);
        // Кадр
        this.processFrame();
        // OLA: сдвиг + накопление
        this.outBuf.copyWithin(0, hop);
        this.outBuf.fill(0, N - hop);
        for (let j = 0; j < N; j++) this.outBuf[j] += this.olaTemp[j];
      }

      // Огибающие
      const a = Math.abs(y);
      this.fastEnv = a > this.fastEnv
        ? this.aFastA * this.fastEnv + (1 - this.aFastA) * a
        : this.aFastR * this.fastEnv + (1 - this.aFastR) * a;
      this.slowEnv = a > this.slowEnv
        ? this.aSlowA * this.slowEnv + (1 - this.aSlowA) * a
        : this.aSlowR * this.slowEnv + (1 - this.aSlowR) * a;

      // Защита от резких звуков
      const ratio = this.fastEnv / Math.max(this.slowEnv, 1e-5);
      let transTarget = 1;
      if (ratio > 1.6 && this.transient > 0) {
        transTarget = Math.max(0.2, 1 / Math.pow(ratio, this.transient));
      }
      this.transGain = this.aTrans * this.transGain + (1 - this.aTrans) * transTarget;

      // Шумовой гейт
      const gateTarget = a < gateLin ? Math.max(0.05, a / gateLin) : 1;
      this.gateEnv = this.aGate * this.gateEnv + (1 - this.aGate) * gateTarget;

      // Сборка
      y = y * this.transGain * this.gateEnv * this.agcGain * this.gainMaster;

      // Лимитер
      if (y > 0.95) y = 0.95;
      else if (y < -0.95) y = -0.95;

      out[i] = y;
    }

    return true;
  }
}

registerProcessor('listen-processor', ListenProcessor);