// Vedon tunnistus ja tunnusluvut.
//
// Veto alkaa, kun voima ylittää START_KG, ja päättyy, kun voima on pysynyt
// alle END_KG:n vähintään END_HOLD_MS ajan (hystereesi estää värinästä
// johtuvat katkokset). Liian lyhyet vedot hylätään.

const START_KG = 2.0;
const END_KG = 1.0;
const END_HOLD_MS = 300;
const MIN_PULL_MS = 500;

class PullDetector {
  constructor(onPull) {
    this.onPull = onPull;
    this.active = null;     // { samples: [[t, kg], ...] }
    this.belowSince = null;
  }

  push(t, kg) {
    if (!this.active) {
      if (kg >= START_KG) {
        this.active = { samples: [[t, kg]] };
        this.belowSince = null;
      }
      return;
    }

    this.active.samples.push([t, kg]);

    if (kg < END_KG) {
      if (this.belowSince === null) this.belowSince = t;
      if (t - this.belowSince >= END_HOLD_MS) this.finish();
    } else {
      this.belowSince = null;
    }
  }

  finish() {
    const s = this.active.samples;
    this.active = null;
    this.belowSince = null;

    // Leikkaa lopun lepojakso pois
    let end = s.length - 1;
    while (end > 0 && s[end][1] < END_KG) end--;
    const samples = s.slice(0, end + 1);

    const stats = computeStats(samples);
    if (stats.durationMs < MIN_PULL_MS) return;
    this.onPull({ ...stats, samples });
  }
}

function computeStats(samples) {
  const t0 = samples[0][0];
  const durationMs = samples[samples.length - 1][0] - t0;

  let peakKg = 0, peakIdx = 0, area = 0;
  for (let i = 0; i < samples.length; i++) {
    const kg = samples[i][1];
    if (kg > peakKg) { peakKg = kg; peakIdx = i; }
    if (i > 0) {
      const dt = (samples[i][0] - samples[i - 1][0]) / 1000;
      area += ((samples[i][1] + samples[i - 1][1]) / 2) * dt;
    }
  }
  const avgKg = durationMs > 0 ? area / (durationMs / 1000) : peakKg;
  const timeToPeakMs = samples[peakIdx][0] - t0;

  // RFD (rate of force development): nousunopeus 20 % -> 80 % huippuvoimasta
  let t20 = null, t80 = null;
  for (let i = 0; i <= peakIdx; i++) {
    const [t, kg] = samples[i];
    if (t20 === null && kg >= 0.2 * peakKg) t20 = t;
    if (t80 === null && kg >= 0.8 * peakKg) { t80 = t; break; }
  }
  const rfdKgPerS = (t20 !== null && t80 !== null && t80 > t20)
    ? (0.6 * peakKg) / ((t80 - t20) / 1000)
    : null;

  return {
    durationMs,
    peakKg: round(peakKg),
    avgKg: round(avgKg),
    timeToPeakMs,
    rfdKgPerS: rfdKgPerS === null ? null : round(rfdKgPerS),
  };
}

function round(x) { return Math.round(x * 100) / 100; }

module.exports = { PullDetector, computeStats };
