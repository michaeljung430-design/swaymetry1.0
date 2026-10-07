// Deterministic biomechanics calculation engine. Pure functions only --
// no DOM access -- so this can run identically in the browser or under
// Node for testing. The AI layer (ai-analysis.js) must never compute
// geometry itself; it only receives the already-calculated output of
// this module and turns it into PT-readable language.
(function (global) {
  const mean = a => { const v = a.filter(x => x != null && !Number.isNaN(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
  const round = (v, d = 4) => v == null || Number.isNaN(v) || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d;

  // ---- Confidence / quality thresholds (adjustable -- not clinical standards) ----
  const DEFAULT_CONFIDENCE_THRESHOLDS = { strong: 0.85, usable: 0.60 };
  function confidenceTier(c, thresholds = DEFAULT_CONFIDENCE_THRESHOLDS) {
    if (c == null) return 'unknown';
    if (c >= thresholds.strong) return 'strong';
    if (c >= thresholds.usable) return 'usable';
    return 'unreliable';
  }

  // ---- Core geometry primitives ----
  function calculateDistance(a, b) {
    if (!a || !b || a.x == null || b.x == null) return null;
    const dz = (a.z != null && b.z != null) ? (a.z - b.z) : 0;
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + dz ** 2);
  }

  function calculateNormalizedDistance(a, b, scale) {
    const d = calculateDistance(a, b);
    if (d == null || !scale) return null;
    return d / scale;
  }

  // Angle at vertex b, formed by rays b->a and b->c. Per spec: vector1 = a-b,
  // vector2 = c-b, angle = arccos(dot/(|v1||v2|)), cosine clamped to [-1,1].
  function calculateAngle(a, b, c) {
    if (!a || !b || !c || a.x == null || b.x == null || c.x == null) return null;
    const v1 = { x: a.x - b.x, y: a.y - b.y, z: (a.z ?? 0) - (b.z ?? 0) };
    const v2 = { x: c.x - b.x, y: c.y - b.y, z: (c.z ?? 0) - (b.z ?? 0) };
    const m1 = Math.sqrt(v1.x ** 2 + v1.y ** 2 + v1.z ** 2);
    const m2 = Math.sqrt(v2.x ** 2 + v2.y ** 2 + v2.z ** 2);
    if (!m1 || !m2) return null;
    const dot = v1.x * v2.x + v1.y * v2.y + v1.z * v2.z;
    const cos = Math.max(-1, Math.min(1, dot / (m1 * m2)));
    return Math.acos(cos) * 180 / Math.PI;
  }

  // Signed perpendicular distance of `point` from the line through
  // lineStart->lineEnd (2D, image plane). Sign is consistent for a given
  // line direction, so it distinguishes medial vs lateral displacement.
  function calculateLineDeviation(point, lineStart, lineEnd) {
    if (!point || !lineStart || !lineEnd || point.x == null || lineStart.x == null || lineEnd.x == null) return null;
    const dx = lineEnd.x - lineStart.x, dy = lineEnd.y - lineStart.y;
    const lineLen = Math.hypot(dx, dy);
    if (!lineLen) return null;
    const cross = dx * (point.y - lineStart.y) - dy * (point.x - lineStart.x);
    return cross / lineLen;
  }

  // Angle of the line left->right relative to horizontal, degrees.
  // atan2(right.y-left.y, right.x-left.x) as specified.
  function calculateTilt(leftPoint, rightPoint) {
    if (!leftPoint || !rightPoint || leftPoint.x == null || rightPoint.x == null) return null;
    const angle=Math.atan2(rightPoint.y - leftPoint.y, rightPoint.x - leftPoint.x) * 180 / Math.PI;
    return ((angle+270)%180)-90;
  }

  // Trunk lean relative to vertical. Vector hipMid->shoulderMid; 0 = perfectly
  // upright. Sign: positive = lean toward +x (image-right), matching the
  // atan2(dx, -dy) convention (image-up is -y).
  function calculateTrunkAngle(shoulderMid, hipMid) {
    if (!shoulderMid || !hipMid || shoulderMid.x == null || hipMid.x == null) return null;
    const dx = shoulderMid.x - hipMid.x, dy = shoulderMid.y - hipMid.y;
    return Math.atan2(dx, -dy) * 180 / Math.PI;
  }

  function midpoint(a, b) {
    if (!a || !b || a.x == null || b.x == null) return null;
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z != null && b.z != null) ? (a.z + b.z) / 2 : null };
  }

  // ---- Time-series helpers ----
  // series: [{t, value}], value may be null (gap). Central differences where
  // possible, falling back to forward/backward differences at the edges.
  function calculateVelocity(series) {
    const pts = series.filter(p => p.value != null);
    if (pts.length < 2) return [];
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      let v;
      if (i > 0 && i < pts.length - 1) {
        const dt = pts[i + 1].t - pts[i - 1].t;
        v = dt > 0 ? (pts[i + 1].value - pts[i - 1].value) / dt : null;
      } else if (i === 0) {
        const dt = pts[i + 1].t - pts[i].t;
        v = dt > 0 ? (pts[i + 1].value - pts[i].value) / dt : null;
      } else {
        const dt = pts[i].t - pts[i - 1].t;
        v = dt > 0 ? (pts[i].value - pts[i - 1].value) / dt : null;
      }
      out.push({ t: pts[i].t, value: v });
    }
    return out;
  }

  function calculateAcceleration(velocitySeries) { return calculateVelocity(velocitySeries); }

  function calculateRange(values) { const v = values.filter(x => x != null); return v.length ? Math.max(...v) - Math.min(...v) : null; }
  function calculateVariability(values) { const v = values.filter(x => x != null); if (v.length < 2) return 0; const m = mean(v); return Math.sqrt(mean(v.map(x => (x - m) ** 2))); }

  // abs(left-right) / avg(|left|,|right|) * 100. Returns null if both are null.
  function calculateSymmetry(left, right) {
    if (left == null || right == null) return null;
    const denom = (Math.abs(left) + Math.abs(right)) / 2;
    if (!denom) return 0;
    return Math.abs(left - right) / denom * 100;
  }

  function calculateSwayTrajectory(series) { return series.filter(s => s.x != null && s.y != null).map(s => ({ t: s.t, x: s.x, y: s.y })); }

  function calculateSwayPath(series) {
    const pts = calculateSwayTrajectory(series);
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    return total;
  }

  function calculateMaxExcursion(series, axis) {
    const pts = series.filter(s => s[axis] != null);
    if (!pts.length) return null;
    const m = mean(pts.map(p => p[axis]));
    return Math.max(...pts.map(p => Math.abs(p[axis] - m)));
  }

  // Approximate 95% confidence sway-area ellipse (same formula family used
  // elsewhere in this app): area = 5.991*pi*sqrt(varX*varY - cov^2).
  function calculateSwayArea(series) {
    const pts = calculateSwayTrajectory(series);
    if (pts.length < 5) return null;
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const mx = mean(xs), my = mean(ys);
    const vx = mean(xs.map(v => (v - mx) ** 2)), vy = mean(ys.map(v => (v - my) ** 2));
    const cov = mean(xs.map((v, i) => (v - mx) * (ys[i] - my)));
    const disc = Math.max(0, vx * vy - cov * cov);
    return 5.991 * Math.PI * Math.sqrt(disc);
  }

  // Builds the standard "preserve the full series" time-series object shape
  // required for every interpreted measurement.
  function buildTimeSeries(name, unit, samples, peakLabeler) {
    const values = samples.map(s => s.value).filter(v => v != null);
    const result = {
      name, unit,
      samples: samples.map(s => ({ t: round(s.t, 3), value: round(s.value, 4) })),
      mean: round(mean(values)),
      min: values.length ? round(Math.min(...values)) : null,
      max: values.length ? round(Math.max(...values)) : null,
      range: round(calculateRange(values)),
      std: round(calculateVariability(values)),
      peaks: {},
    };
    if (peakLabeler && values.length) {
      const maxSample = samples.reduce((best, s) => (s.value != null && (!best || s.value > best.value)) ? s : best, null);
      const minSample = samples.reduce((best, s) => (s.value != null && (!best || s.value < best.value)) ? s : best, null);
      if (maxSample) result.peaks.max_timestamp = round(maxSample.t, 3);
      if (minSample) result.peaks.min_timestamp = round(minSample.t, 3);
    }
    return result;
  }

  // ---- Event / correction detection ----
  // Groups a run of consecutive threshold-exceeding samples (peak-based),
  // used for simple spike-style events.
  function detectPeakEvents(series, { thresholdFn, type, describe, minSeparation = 0.4 }) {
    const events = [];
    let active = null;
    for (const s of series) {
      if (s.value == null) continue;
      const exceeds = thresholdFn(s.value);
      if (exceeds) { if (!active || Math.abs(s.value) > Math.abs(active.value)) active = { t: s.t, value: s.value }; }
      else if (active) { events.push({ timestamp_seconds: round(active.t, 3), type, value: round(active.value), description: describe(active.value, active.t) }); active = null; }
    }
    if (active) events.push({ timestamp_seconds: round(active.t, 3), type, value: round(active.value), description: describe(active.value, active.t) });
    // Merge events that land within minSeparation of a stronger neighbor.
    events.sort((a, b) => a.timestamp_seconds - b.timestamp_seconds);
    const merged = [];
    for (const e of events) {
      const prev = merged[merged.length - 1];
      if (prev && (e.timestamp_seconds - prev.timestamp_seconds) < minSeparation) {
        if (Math.abs(e.value) > Math.abs(prev.value)) merged[merged.length - 1] = e;
      } else merged.push(e);
    }
    return merged;
  }

  // A foot-repositioning event requires: displacement beyond a normalized
  // threshold, persisting for multiple consecutive frames, then settling at
  // a meaningfully different location (not just a jitter spike).
  function detectFootCorrections(series, { thresholdNormalized = 0.12, minFrames = 3, settleFrames = 3 } = {}) {
    const pts = series.filter(s => s.x != null && s.y != null && s.scale);
    if (pts.length < minFrames + settleFrames) return [];
    const events = [];
    let i = 0;
    const baseline = pts[0];
    let refX = baseline.x, refY = baseline.y;
    while (i < pts.length) {
      const dx = (pts[i].x - refX) / pts[i].scale, dy = (pts[i].y - refY) / pts[i].scale;
      const dist = Math.hypot(dx, dy);
      if (dist >= thresholdNormalized) {
        let run = 1, j = i + 1;
        while (j < pts.length && Math.hypot((pts[j].x - refX) / pts[j].scale, (pts[j].y - refY) / pts[j].scale) >= thresholdNormalized) { run++; j++; }
        if (run >= minFrames) {
          const settleEnd = Math.min(pts.length, j + settleFrames);
          const settled = pts.slice(j, settleEnd);
          const settledOk = settled.length >= Math.min(settleFrames, pts.length - j);
          events.push({
            timestamp_seconds: round(pts[i].t, 3),
            magnitude: round(dist),
            direction: Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'lateral' : 'medial') : (dy >= 0 ? 'posterior' : 'anterior'),
            settled: settledOk,
          });
          refX = pts[j - 1]?.x ?? refX; refY = pts[j - 1]?.y ?? refY;
          i = j; continue;
        }
      }
      i++;
    }
    return events;
  }

  // Fraction of frames with all required landmarks at/above the usable
  // confidence threshold, overall and per named region.
  function calculateTrackingQuality(frames, regionLandmarks = {}, thresholds = DEFAULT_CONFIDENCE_THRESHOLDS) {
    if (!frames.length) return { overall: 0, byRegion: {}, excludedFrames: 0, tier: 'unreliable' };
    const requiredAll = [...new Set(Object.values(regionLandmarks).flat())];
    let goodFrames = 0;
    const regionGood = Object.fromEntries(Object.keys(regionLandmarks).map(k => [k, 0]));
    for (const f of frames) {
      const confs = requiredAll.map(name => f.landmarks?.[name]?.confidence).filter(c => c != null);
      const allOk = requiredAll.every(name => (f.landmarks?.[name]?.confidence ?? 0) >= thresholds.usable);
      if (allOk) goodFrames++;
      for (const [region, names] of Object.entries(regionLandmarks)) {
        const ok = names.every(name => (f.landmarks?.[name]?.confidence ?? 0) >= thresholds.usable);
        if (ok) regionGood[region]++;
      }
    }
    const overall = goodFrames / frames.length;
    const byRegion = Object.fromEntries(Object.entries(regionGood).map(([k, v]) => [k, round(v / frames.length, 3)]));
    return { overall: round(overall, 3), byRegion, excludedFrames: frames.length - goodFrames, totalFrames: frames.length, tier: confidenceTier(overall, thresholds) };
  }

  // ---- Smoothing / outlier rejection (processing pipeline, never mutates raw) ----
  // Simple one-euro-style low-pass filter: cheap, causal, good default for
  // pose landmarks. minCutoff/beta are conservative defaults, not tuned.
  function oneEuroSmooth(series, { minCutoff = 1.0, beta = 0.02 } = {}) {
    const pts = series.filter(s => s.value != null);
    if (pts.length < 2) return series;
    const alpha = (cutoff, dt) => { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); };
    let prevValue = pts[0].value, prevDeriv = 0;
    const smoothed = new Map([[pts[0].t, pts[0].value]]);
    for (let i = 1; i < pts.length; i++) {
      const dt = Math.max(0.001, pts[i].t - pts[i - 1].t);
      const deriv = (pts[i].value - prevValue) / dt;
      const dCutoff = 1.0;
      const aDeriv = alpha(dCutoff, dt);
      const smoothDeriv = aDeriv * deriv + (1 - aDeriv) * prevDeriv;
      const cutoff = minCutoff + beta * Math.abs(smoothDeriv);
      const a = alpha(cutoff, dt);
      const value = a * pts[i].value + (1 - a) * prevValue;
      smoothed.set(pts[i].t, value);
      prevValue = value; prevDeriv = smoothDeriv;
    }
    return series.map(s => ({ t: s.t, value: smoothed.has(s.t) ? smoothed.get(s.t) : null }));
  }

  // Flags a sample as an outlier if it deviates from the local median by more
  // than `factor` times the local median-absolute-deviation. Outliers are
  // nulled (treated as gaps), never silently altered.
  function rejectOutliers(series, { window = 5, factor = 4 } = {}) {
    const values = series.map(s => s.value);
    return series.map((s, i) => {
      if (s.value == null) return s;
      const lo = Math.max(0, i - window), hi = Math.min(values.length, i + window + 1);
      const local = values.slice(lo, hi).filter(v => v != null);
      if (local.length < 3) return s;
      const sorted = [...local].sort((a, b) => a - b);
      const med = sorted[Math.floor(sorted.length / 2)];
      const mad = (() => { const devs = local.map(v => Math.abs(v - med)).sort((a, b) => a - b); return devs[Math.floor(devs.length / 2)] || 0.0001; })();
      if (Math.abs(s.value - med) > factor * mad) return { t: s.t, value: null };
      return s;
    });
  }

  global.Biomech = {
    DEFAULT_CONFIDENCE_THRESHOLDS, confidenceTier,
    calculateDistance, calculateNormalizedDistance, calculateAngle, calculateLineDeviation, calculateTilt, calculateTrunkAngle, midpoint,
    calculateVelocity, calculateAcceleration, calculateRange, calculateVariability, calculateSymmetry,
    calculateSwayTrajectory, calculateSwayPath, calculateMaxExcursion, calculateSwayArea,
    buildTimeSeries, detectPeakEvents, detectFootCorrections, calculateTrackingQuality,
    oneEuroSmooth, rejectOutliers,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) module.exports = (typeof window !== 'undefined' ? window.Biomech : globalThis.Biomech);
