// ListenBoost v0.4.1 — AudioWorklet DSP + Vosk 16kHz Streamer

class ListenProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.N = 512;
    this.hop = 256;
    this.nBins = this.N / 2 + 1;
    const sr = sampleRate;
    const fps = sr / this.hop;

    this.window = new Float32Array(this.N);
    for (let i = 0; i < this.N; i++) {
      const h = 0.5 * (1 - Math.cos((2 * Math.PI * i) / this.N));
      this.window[i] = Math.sqrt(Math.max(h, 1e-8));
    }

    this.inBuf = new Float32Array(this.N);
    this.hopBuf = new Float32Array(this.hop);
    this.outBuf = new Float32Array(this.N);
    this.olaTemp = new Float32Array(this.N);
    this.hopPos = 0;

    this.re = new Float32Array(this.N);
    this.im = new Float32Array(this.N);
    this.cos = new Float32Array(this.N);
    this.sin = new Float32Array(this.N);
    for (let i = 0; i < this.N; i++) {
      const ang = (-2 * Math.PI * i) / this.N;
      this.cos[i] = Math.cos(ang);
      this.sin[i] = Math.sin(ang);
    }
    this.bitrev = new Uint16Array(this.N);
    const logN = Math.log2(this.N);
    for (let i = 0; i < this.N; i++) {
      let r = 0;
      for (let b = 0; b < logN; b++) r = (r << 1) | ((i >> b) & 1);
      this.bitrev[i] = r;
    }

    this.smoothP = new Float32Array(this.nBins);
    this.minP = new Float32Array(this.nBins).fill(1e10);
    this.minCount = new Uint16Array(this.nBins);
    this.noiseP = new Float32Array(this.nBins).fill(1e-10);
    this.smoothGain = new Float32Array(this.nBins).fill(1);
    this.prevClean = new Float32Array(this.nBins);
    this.prevGain = new Float32Array(this.nBins).fill(1);
    this.minResetPeriod = 400;
    this.sibEnv = 0;

    this.frameCount = 0;
    this.vadState = 0;
    this.vadHold = 0;
    this.vadPending = 0;

    this.fastEnv = 0;
    this.slowEnv = 1e-4;
    this.transGain = 1;
    this.gateEnv = 1;
    this.agcEnv = 1e-3;
    this.agcGain = 1;

    this.aFastA = Math.exp(-1 / (0.002 * sr));
    this.aFastR = Math.exp(-1 / (0.080 * sr));
    this.aSlowA = Math.exp(-1 / (0.200 * sr));
    this.aSlowR = Math.exp(-1 / (0.400 * sr));
    this.aAgcEnv  = Math.exp(-1 / (0.6 * fps));
    this.aAgcGain = Math.exp(-1 / (0.1 * fps));
    this.aGate    = Math.exp(-1 / (0.1 * sr));
    this.aTrans   = Math.exp(-1 / (0.02 * sr));

    this.gainMaster = 1.5;
    this.maxAgc = 4;
    this.gateDb = -50;
    this.transient = 0.6;
    this.nrStrength = 0.5;
    this.nrEnabled = true;
    this.deEssEnabled = true;

    // Vosk Downsampler
    this.voskRatio = sr / 16000;
    this.voskStep = 0;
    this.voskBuf = new Int16Array(4096); // ~256мс аудио
    this.voskPos = 0;

    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.type !== 'params') return;
      if (d.gain !== undefined) this.gainMaster = d.gain;
      if (d.maxAgc !== undefined) this.maxAgc = d.maxAgc;
      if (d.gate !== undefined) this.gateDb = d.gate;
      if (d.transient !== undefined) this.transient = d.transient;
      if (d.nr !== undefined) this.nrStrength = d.nr;
      if (d.nrEnabled !== undefined) this.nrEnabled = d.nrEnabled;
      if (d.deEss !== undefined) this.deEssEnabled = d.deEss;
    };
  }

  fft(re, im) {
    const N = this.N, bitrev = this.bitrev;
    for (let i = 0; i < N; i++) {
      const j = bitrev[i];
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    const cos = this.cos, sin = this.sin;
    for (let len = 2; len <= N; len <<= 1) {
      const half = len >> 1, step = N / len;
      for (let i = 0; i < N; i += len) {
        for (let k = 0; k < half; k++) {
          const tw = k * step, wRe = cos[tw], wIm = sin[tw], a = i + k, b = a + half;
          const tRe = wRe * re[b] - wIm * im[b], tIm = wRe * im[b] + wIm * re[b];
          re[b] = re[a] - tRe; im[b] = im[a] - tIm; re[a] += tRe; im[a] += tIm;
        }
      }
    }
  }

  ifft(re, im) {
    const N = this.N;
    for (let i = 0; i < N; i++) im[i] = -im[i];
    this.fft(re, im);
    for (let i = 0; i < N; i++) { re[i] /= N; im[i] = -im[i] / N; }
  }

  processFrame() {
    const N = this.N, nBins = this.nBins;
    const re = this.re, im = this.im, win = this.window;
    const sr = sampleRate;

    for (let i = 0; i < N; i++) { re[i] = this.inBuf[i] * win[i]; im[i] = 0; }
    this.fft(re, im);

    const nrActive = this.nrEnabled && this.nrStrength > 0;

    if (nrActive) {
      const alpha = 1 + this.nrStrength * 3;
      const floor = Math.max(0.02, 0.1 - this.nrStrength * 0.08);
      const dd = 0.98;

      for (let k = 0; k < nBins; k++) {
        const xr = re[k], imVal = im[k];
        const power = xr * xr + imVal * imVal;
        this.smoothP[k] = 0.7 * this.smoothP[k] + 0.3 * power;

        if (this.smoothP[k] < this.minP[k]) { this.minP[k] = this.smoothP[k]; this.minCount[k] = 0; }
        else if (++this.minCount[k] > this.minResetPeriod) { this.minP[k] = this.smoothP[k]; this.minCount[k] = 0; }

        const noiseEst = Math.max(this.minP[k] * 1.5, 1e-10);
        this.noiseP[k] = 0.9 * this.noiseP[k] + 0.1 * noiseEst;
        const gamma = power / (this.noiseP[k] + 1e-10);
        const xiSNR = dd * (this.prevClean[k] / (this.noiseP[k] + 1e-10)) + (1 - dd) * Math.max(gamma - 1, 0);
        let g = xiSNR / (1 + xiSNR);
        if (g < floor) g = floor; if (g > 1) g = 1;

        this.smoothGain[k] = 0.7 * this.smoothGain[k] + 0.3 * g;
        this.prevGain[k] = this.smoothGain[k];
        this.prevClean[k] = power * this.smoothGain[k] * this.smoothGain[k];

        re[k] = xr * this.smoothGain[k]; im[k] = imVal * this.smoothGain[k];
      }

      if (this.deEssEnabled) {
        const sibStart = Math.max(2, Math.floor(4500 * N / sr));
        let lowP = 0, highP = 0;
        for (let k = 2; k < sibStart; k++) lowP += this.smoothP[k];
        for (let k = sibStart; k < nBins; k++) highP += this.smoothP[k];
        const ratio = highP / (lowP + highP + 1e-10);
        let red = 0;
        if (ratio > 0.25) red = Math.min(0.55, (ratio - 0.25) * 2.5);
        this.sibEnv = 0.7 * this.sibEnv + 0.3 * red;
        if (this.sibEnv > 0.02) { for (let k = sibStart; k < nBins; k++) { re[k] *= (1 - this.sibEnv); im[k] *= (1 - this.sibEnv); } }
      }
    }

    for (let k = 1; k < N / 2; k++) { re[N - k] = re[k]; im[N - k] = -im[k]; }
    im[0] = 0; im[N / 2] = 0;
    this.ifft(re, im);
    for (let i = 0; i < N; i++) this.olaTemp[i] = re[i] * win[i];

    let sum = 0;
    for (let i = 0; i < N; i++) sum += this.olaTemp[i] * this.olaTemp[i];
    const rms = Math.sqrt(sum / N);
    this.agcEnv = this.aAgcEnv * this.agcEnv + (1 - this.aAgcEnv) * Math.max(rms, 1e-4);
    let target = Math.max(0.6, Math.min(this.maxAgc, 0.12 / this.agcEnv));
    this.agcGain = this.aAgcGain * this.agcGain + (1 - this.aAgcGain) * target;

    const lo = Math.max(2, Math.floor(200 * N / sr)), hi = Math.min(nBins, Math.floor(4000 * N / sr));
    let sig = 0, noi = 0;
    for (let k = lo; k < hi; k++) { sig += this.smoothP[k]; noi += this.noiseP[k]; }
    const snr = sig / (noi + 1e-10);
    const now = snr > 3.0 ? 1 : 0;

    if (now !== this.vadPending) { this.vadPending = now; this.vadHold = 0; }
    if (++this.vadHold > 12 && this.vadPending !== this.vadState) {
      this.vadState = this.vadPending; this.port.postMessage({ type: 'vad', active: this.vadState });
    }
  }

  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0][0];
    if (!inp || !inp.length) { out.fill(0); return true; }

    const n = out.length, N = this.N, hop = this.hop, ch = inp.length;
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
        this.inBuf.copyWithin(0, hop);
        this.inBuf.set(this.hopBuf, N - hop);
        this.processFrame();
        this.outBuf.copyWithin(0, hop);
        this.outBuf.fill(0, N - hop);
        for (let j = 0; j < N; j++) this.outBuf[j] += this.olaTemp[j];
      }

      const a = Math.abs(y);
      this.fastEnv = a > this.fastEnv ? this.aFastA * this.fastEnv + (1 - this.aFastA) * a : this.aFastR * this.fastEnv + (1 - this.aFastR) * a;
      this.slowEnv = a > this.slowEnv ? this.aSlowA * this.slowEnv + (1 - this.aSlowA) * a : this.aSlowR * this.slowEnv + (1 - this.aSlowR) * a;

      const ratio = this.fastEnv / Math.max(this.slowEnv, 1e-5);
      let tTarget = 1;
      if (ratio > 1.6 && this.transient > 0) tTarget = Math.max(0.2, 1 / Math.pow(ratio, this.transient));
      this.transGain = this.aTrans * this.transGain + (1 - this.aTrans) * tTarget;

      const gTarget = a < gateLin ? Math.max(0.05, a / gateLin) : 1;
      this.gateEnv = this.aGate * this.gateEnv + (1 - this.aGate) * gTarget;

      y = y * this.transGain * this.gateEnv * this.agcGain * this.gainMaster;
      if (y > 0.95) y = 0.95; else if (y < -0.95) y = -0.95;
      out[i] = y;

      // --- ОТПРАВКА В VOSK ---
      this.voskStep += 16000 / sampleRate;
      if (this.voskStep >= 1) {
        this.voskStep -= 1;
        this.voskBuf[this.voskPos++] = Math.max(-1, Math.min(1, y)) * 32767;
        if (this.voskPos >= this.voskBuf.length) {
          // Отправляем САМ МАССИВ (Int16Array), а не его .buffer
          this.port.postMessage({ type: 'vosk_audio', buffer: this.voskBuf });
          this.voskBuf = new Int16Array(4096); // Пересоздаем
          this.voskPos = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('listen-processor', ListenProcessor);
