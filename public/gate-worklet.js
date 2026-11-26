// Шумовой гейт: работает в аудиопотоке, поэтому не тормозит в свёрнутой вкладке.
class NoiseGate extends AudioWorkletProcessor {
  constructor() {
    super();
    this.threshold = -100;          // дБ; -100 = гейт выключен
    this.holdSamples = 0.3 * sampleRate;
    this.hold = 0;
    this.gain = 1;
    this.attack = 1 - Math.exp(-1 / (0.004 * sampleRate));
    this.release = 1 - Math.exp(-1 / (0.06 * sampleRate));
    this.port.onmessage = (e) => {
      if (typeof e.data?.threshold === 'number') this.threshold = e.data.threshold;
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;

    const ch0 = input[0];
    let sum = 0;
    for (let i = 0; i < ch0.length; i++) sum += ch0[i] * ch0[i];
    const db = 10 * Math.log10(sum / ch0.length + 1e-12);

    if (this.threshold <= -100 || db >= this.threshold) this.hold = this.holdSamples;
    else this.hold = Math.max(0, this.hold - ch0.length);
    const target = this.hold > 0 ? 1 : 0;

    let g = this.gain;
    for (let i = 0; i < ch0.length; i++) {
      g += (target - g) * (target > g ? this.attack : this.release);
      for (let c = 0; c < output.length; c++) {
        const src = input[c] || ch0;
        output[c][i] = src[i] * g;
      }
    }
    this.gain = g;
    return true;
  }
}
registerProcessor('noise-gate', NoiseGate);
