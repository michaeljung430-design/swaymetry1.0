// Interpretation pipeline: raw landmarks -> confidence check -> outlier
// rejection -> smoothing -> normalization -> biomechanical calculations ->
// PT-facing metrics tree. This is the only place that turns raw frames into
// clinical numbers; the AI layer never sees raw frames, only this output,
// and never computes geometry itself.
(function (global) {
  const B = (typeof window !== 'undefined' ? window.Biomech : global.Biomech);
  const mean = a => { const v = a.filter(x => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
  const round = (v, d = 4) => v == null || Number.isNaN(v) || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d;
  const median = a => { const v = a.filter(x => x != null).sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : null; };

  const REGION_LANDMARKS = {
    trunk: ['left_shoulder', 'right_shoulder', 'left_hip', 'right_hip'],
    left_knee: ['left_hip', 'left_knee', 'left_ankle'],
    right_knee: ['right_hip', 'right_knee', 'right_ankle'],
    left_ankle: ['left_knee', 'left_ankle', 'left_foot_index'],
    right_ankle: ['right_knee', 'right_ankle', 'right_foot_index'],
    shoulders: ['left_shoulder', 'right_shoulder'],
    pelvis: ['left_hip', 'right_hip'],
    left_elbow: ['left_shoulder', 'left_elbow', 'left_wrist'],
    right_elbow: ['right_shoulder', 'right_elbow', 'right_wrist'],
  };

  function visible(p, threshold) { return p && p.x != null && (p.confidence == null || p.confidence >= threshold); }

  // Builds a smoothed, outlier-rejected scalar time series from a per-frame
  // extractor function. Raw (unsmoothed) values are kept alongside so the
  // pipeline never silently loses what was actually measured.
  function deriveSeries(frames, extractor) {
    const raw = frames.map(f => ({ t: f.timestamp_seconds, value: extractor(f) }));
    const cleaned = B.rejectOutliers(raw);
    const smoothed = B.oneEuroSmooth(cleaned);
    return { raw, smoothed };
  }

  function estimateScale(frames, threshold) {
    const hipWidths = frames.map(f => { const l = f.landmarks.left_hip, r = f.landmarks.right_hip; return (visible(l, threshold) && visible(r, threshold)) ? B.calculateDistance(l, r) : null; }).filter(v => v != null);
    if (hipWidths.length >= frames.length * 0.3) return { value: median(hipWidths), reference: 'hip_width' };
    const shoulderWidths = frames.map(f => { const l = f.landmarks.left_shoulder, r = f.landmarks.right_shoulder; return (visible(l, threshold) && visible(r, threshold)) ? B.calculateDistance(l, r) : null; }).filter(v => v != null);
    if (shoulderWidths.length) return { value: median(shoulderWidths), reference: 'shoulder_width' };
    return { value: null, reference: 'unavailable' };
  }

  function thirdsWindows(durationSeconds) {
    const t1 = durationSeconds / 3, t2 = 2 * durationSeconds / 3;
    return { early: [0, t1], middle: [t1, t2], late: [t2, durationSeconds] };
  }
  function windowStats(series, [start, end]) {
    const vals = series.filter(s => s.t >= start && s.t < end && s.value != null).map(s => s.value);
    return { mean: round(mean(vals)), range: round(B.calculateRange(vals)), std: round(B.calculateVariability(vals)) };
  }

  function analyzeTrial(frames, phoneSamples, trialMeta, options = {}) {
    const thresholds = options.thresholds || B.DEFAULT_CONFIDENCE_THRESHOLDS;
    const durationSeconds = trialMeta.duration_seconds || 20;
    // Use aspect-corrected 2D coordinates, never model-estimated depth as metres.
    // Original raw frames remain unchanged in IndexedDB.
    const framesSorted = frames.map(f => {
      const ratio = f.image_width > 0 && f.image_height > 0 ? f.image_width / f.image_height : null;
      return { ...f, landmarks: Object.fromEntries(Object.entries(f.landmarks || {}).map(([name, p]) => [name, { ...p, x: ratio && Number.isFinite(p.x) ? p.x * ratio : null, y: ratio ? p.y : null, z: 0 }])) };
    }).sort((a, b) => a.timestamp_seconds - b.timestamp_seconds);
    const scale = estimateScale(framesSorted, thresholds.usable);
    const quality = B.calculateTrackingQuality(framesSorted, REGION_LANDMARKS, thresholds);
    const cameraOrientation = options.cameraOrientation || 'front';

    // ---- Per-frame derived points ----
    function point(f, name) { const p = f.landmarks[name]; return visible(p, thresholds.usable) ? p : null; }
    function bodyCenterAt(f) {
      const hip = point(f, 'left_hip') && point(f, 'right_hip') ? B.midpoint(point(f, 'left_hip'), point(f, 'right_hip')) : null;
      const sh = point(f, 'left_shoulder') && point(f, 'right_shoulder') ? B.midpoint(point(f, 'left_shoulder'), point(f, 'right_shoulder')) : null;
      if (!hip || !sh) return null;
      return { x: 0.65 * hip.x + 0.35 * sh.x, y: 0.65 * hip.y + 0.35 * sh.y };
    }

    // ---- Balance & stability: body-center trajectory ----
    const bodyCenterSeries = framesSorted.map(f => ({ t: f.timestamp_seconds, ...(bodyCenterAt(f) || { x: null, y: null }) }));
    const validCenters = bodyCenterSeries.filter(p => p.x != null);
    const centerMeanX = mean(validCenters.map(p => p.x)), centerMeanY = mean(validCenters.map(p => p.y));
    const swayPathRaw = B.calculateSwayPath(bodyCenterSeries);
    const swayPath = scale.value ? swayPathRaw / scale.value : null;
    const swayVelocity = swayPath != null ? swayPath / durationSeconds : null;
    const mlSeries = { raw: bodyCenterSeries.map(p => ({ t: p.t, value: p.x != null && scale.value ? (p.x - centerMeanX) / scale.value : null })) };
    const apSeries = { raw: bodyCenterSeries.map(p => ({ t: p.t, value: p.y != null && scale.value ? (p.y - centerMeanY) / scale.value : null })) };
    const swayArea = scale.value ? B.calculateSwayArea(validCenters.map(p => ({ x: (p.x - centerMeanX) / scale.value, y: (p.y - centerMeanY) / scale.value }))) : null;
    const balance_stability = {
      unit: 'normalized body units (relative to ' + scale.reference + ')',
      body_center_path: validCenters.map(p => ({ t: round(p.t, 3), x: round(p.x), y: round(p.y) })),
      mediolateral_sway: B.buildTimeSeries('mediolateral_sway', 'normalized_units', mlSeries.raw, true),
      anterior_posterior_sway: B.buildTimeSeries('anterior_posterior_sway', 'normalized_units', apSeries.raw, true),
      total_sway_path: round(swayPath),
      sway_velocity: round(swayVelocity),
      max_excursion_ml: scale.value ? round(B.calculateMaxExcursion(validCenters, 'x') / scale.value) : null,
      max_excursion_ap: scale.value ? round(B.calculateMaxExcursion(validCenters, 'y') / scale.value) : null,
      sway_area: round(swayArea),
    };

    // ---- Trunk ----
    const trunkSeries = deriveSeries(framesSorted, f => { const h = point(f, 'left_hip') && point(f, 'right_hip') ? B.midpoint(point(f, 'left_hip'), point(f, 'right_hip')) : null; const s = point(f, 'left_shoulder') && point(f, 'right_shoulder') ? B.midpoint(point(f, 'left_shoulder'), point(f, 'right_shoulder')) : null; return (h && s) ? B.calculateTrunkAngle(s, h) : null; });
    const trunk_angle_ts = B.buildTimeSeries('trunk_lean', 'degrees', trunkSeries.smoothed, true);
    const trunk = {
      camera_view_note: cameraOrientation === 'front' ? 'Front-facing view: lateral trunk lean prioritized; anterior/posterior lean uses estimated depth and is lower confidence.' : 'Side-facing view: anterior/posterior trunk lean prioritized.',
      trunk_lean: trunk_angle_ts,
      mean_lean: trunk_angle_ts.mean, max_deviation: trunk_angle_ts.max != null && trunk_angle_ts.min != null ? round(Math.max(Math.abs(trunk_angle_ts.max), Math.abs(trunk_angle_ts.min))) : null,
      dominant_direction: trunk_angle_ts.mean != null ? (trunk_angle_ts.mean >= 0 ? 'right' : 'left') : null,
      range: trunk_angle_ts.range, std: trunk_angle_ts.std,
      timestamp_of_max: trunk_angle_ts.max != null ? trunk_angle_ts.peaks.max_timestamp : null,
    };

    // ---- Pelvis ----
    const pelvicSeries = deriveSeries(framesSorted, f => (point(f, 'left_hip') && point(f, 'right_hip')) ? B.calculateTilt(point(f, 'left_hip'), point(f, 'right_hip')) : null);
    const pelvic_ts = B.buildTimeSeries('pelvic_tilt', 'degrees', pelvicSeries.smoothed, true);
    const pelvis_hips = {
      pelvic_tilt: pelvic_ts, mean_tilt: pelvic_ts.mean,
      peak_left_drop: pelvic_ts.min, peak_right_drop: pelvic_ts.max,
      range: pelvic_ts.range, std: pelvic_ts.std,
    };

    // ---- Shoulders ----
    const shoulderTiltSeries = deriveSeries(framesSorted, f => (point(f, 'left_shoulder') && point(f, 'right_shoulder')) ? B.calculateTilt(point(f, 'left_shoulder'), point(f, 'right_shoulder')) : null);
    const shoulder_ts = B.buildTimeSeries('shoulder_tilt', 'degrees', shoulderTiltSeries.smoothed, true);
    const shoulders = {
      shoulder_tilt: shoulder_ts, mean_tilt: shoulder_ts.mean,
      max_left_tilt: shoulder_ts.min, max_right_tilt: shoulder_ts.max,
      range: shoulder_ts.range, std: shoulder_ts.std,
    };

    // ---- Knees (both sides) ----
    function kneeAnalysis(side) {
      const hipName = `${side}_hip`, kneeName = `${side}_knee`, ankleName = `${side}_ankle`;
      const angleSeries = deriveSeries(framesSorted, f => (point(f, hipName) && point(f, kneeName) && point(f, ankleName)) ? B.calculateAngle(point(f, hipName), point(f, kneeName), point(f, ankleName)) : null);
      const angle_ts = B.buildTimeSeries(`${side}_knee_angle`, 'degrees', angleSeries.smoothed, true);
      const devSeries = deriveSeries(framesSorted, f => { const h = point(f, hipName), k = point(f, kneeName), a = point(f, ankleName); if (!h || !k || !a || !scale.value) return null; return B.calculateLineDeviation(k, h, a) / scale.value; });
      const dev_ts = B.buildTimeSeries(`${side}_knee_alignment`, 'normalized_units', devSeries.smoothed, true);
      const velocitySeries = B.calculateVelocity(angleSeries.smoothed.filter(s => s.value != null));
      return {
        label: 'camera-derived knee alignment (not a clinical valgus/varus diagnosis)',
        knee_angle: angle_ts, mean_angle: angle_ts.mean, min_angle: angle_ts.min, max_angle: angle_ts.max, angle_range: angle_ts.range, angle_std: angle_ts.std,
        knee_alignment: dev_ts,
        peak_medial_deviation: dev_ts.min, peak_lateral_deviation: dev_ts.max,
        timestamp_of_peak_deviation: (Math.abs(dev_ts.min ?? 0) > Math.abs(dev_ts.max ?? 0)) ? dev_ts.peaks.min_timestamp : dev_ts.peaks.max_timestamp,
        variability: dev_ts.std,
        velocity: B.buildTimeSeries(`${side}_knee_velocity`, 'degrees_per_second', velocitySeries, false),
        tracking_confidence: quality.byRegion[`${side}_knee`] ?? null,
      };
    }
    const left_knee = kneeAnalysis('left'), right_knee = kneeAnalysis('right');

    // ---- Ankles / feet ----
    function ankleAnalysis(side) {
      const kneeName = `${side}_knee`, ankleName = `${side}_ankle`, footName = `${side}_foot_index`;
      const footConfSeries = framesSorted.map(f => f.landmarks[footName]?.confidence ?? null).filter(c => c != null);
      const footConfOk = mean(footConfSeries) != null && mean(footConfSeries) >= thresholds.usable;
      const angleSeries = footConfOk ? deriveSeries(framesSorted, f => (point(f, kneeName) && point(f, ankleName) && point(f, footName)) ? B.calculateAngle(point(f, kneeName), point(f, ankleName), point(f, footName)) : null) : null;
      const angle_ts = angleSeries ? B.buildTimeSeries(`${side}_ankle_angle`, 'degrees', angleSeries.smoothed, true) : null;
      const footSeries = framesSorted.map(f => { const a = point(f, ankleName); return a ? { t: f.timestamp_seconds, x: a.x, y: a.y, scale: scale.value } : { t: f.timestamp_seconds, x: null, y: null, scale: scale.value }; });
      const corrections = scale.value ? B.detectFootCorrections(footSeries, { thresholdNormalized: options.footCorrectionThreshold ?? 0.12 }) : [];
      return {
        ankle_angle: angle_ts,
        angle_available: !!footConfOk,
        unavailable_reason: footConfOk ? null : `${side} foot tracking confidence too low for a reliable ankle angle.`,
        corrections, correction_count: corrections.length,
        tracking_confidence: quality.byRegion[`${side}_ankle`] ?? null,
      };
    }
    const ankles_feet = { left: ankleAnalysis('left'), right: ankleAnalysis('right') };
    const stanceWidthSeries = deriveSeries(framesSorted, f => (point(f, 'left_ankle') && point(f, 'right_ankle') && scale.value) ? B.calculateDistance(point(f, 'left_ankle'), point(f, 'right_ankle')) / scale.value : null);
    ankles_feet.stance_width = B.buildTimeSeries('stance_width', 'normalized_units', stanceWidthSeries.smoothed, false);

    // ---- Elbows / arms (extensible for shoulder exercises) ----
    function elbowAnalysis(side) {
      const s = `${side}_shoulder`, e = `${side}_elbow`, w = `${side}_wrist`;
      const angleSeries = deriveSeries(framesSorted, f => (point(f, s) && point(f, e) && point(f, w)) ? B.calculateAngle(point(f, s), point(f, e), point(f, w)) : null);
      return B.buildTimeSeries(`${side}_elbow_angle`, 'degrees', angleSeries.smoothed, true);
    }
    const left_leg = { knee: left_knee, ankle: ankles_feet.left };
    const right_leg = { knee: right_knee, ankle: ankles_feet.right };
    const arms = { left_elbow_angle: elbowAnalysis('left'), right_elbow_angle: elbowAnalysis('right') };

    // ---- Hip flexion/abduction estimate (thigh vs trunk vector) ----
    function hipEstimate(side) {
      const hipName = `${side}_hip`, kneeName = `${side}_knee`;
      const series = deriveSeries(framesSorted, f => {
        const hip = point(f, hipName), knee = point(f, kneeName);
        const shMid = point(f, 'left_shoulder') && point(f, 'right_shoulder') ? B.midpoint(point(f, 'left_shoulder'), point(f, 'right_shoulder')) : null;
        return (hip && knee && shMid) ? B.calculateAngle(shMid, hip, knee) : null;
      });
      return B.buildTimeSeries(`${side}_hip_thigh_trunk_angle`, 'degrees', series.smoothed, true);
    }
    pelvis_hips.left_hip_angle = hipEstimate('left');
    pelvis_hips.right_hip_angle = hipEstimate('right');

    // ---- Symmetry ----
    const symmetry = {
      knee_flexion: { left: left_knee.min_angle, right: right_knee.min_angle, difference: (left_knee.min_angle != null && right_knee.min_angle != null) ? round(left_knee.min_angle - right_knee.min_angle) : null, symmetry_index: B.calculateSymmetry(left_knee.min_angle, right_knee.min_angle) != null ? round(B.calculateSymmetry(left_knee.min_angle, right_knee.min_angle)) : null },
      knee_rom: { left: left_knee.angle_range, right: right_knee.angle_range, difference: (left_knee.angle_range != null && right_knee.angle_range != null) ? round(left_knee.angle_range - right_knee.angle_range) : null, symmetry_index: B.calculateSymmetry(left_knee.angle_range, right_knee.angle_range) != null ? round(B.calculateSymmetry(left_knee.angle_range, right_knee.angle_range)) : null },
      foot_corrections: { left: ankles_feet.left.correction_count, right: ankles_feet.right.correction_count, difference: ankles_feet.left.correction_count - ankles_feet.right.correction_count },
    };

    // ---- Events timeline ----
    const events = [];
    function addPeakEvents(series, type, describe, thresholdMultiplier = 2) {
      const vals = series.raw.map(s => s.value).filter(v => v != null);
      if (vals.length < 5) return;
      const m = mean(vals), sd = B.calculateVariability(vals);
      const evs = B.detectPeakEvents(series.raw, { thresholdFn: v => Math.abs(v - m) > sd * thresholdMultiplier, type, describe });
      events.push(...evs);
    }
    addPeakEvents(trunkSeries, 'max_trunk_lean', (v, t) => `Large trunk lean (${round(v, 1)}°) at ${round(t, 1)}s.`);
    addPeakEvents(pelvicSeries, 'max_pelvic_tilt', (v, t) => `Large pelvic tilt (${round(v, 1)}°) at ${round(t, 1)}s.`);
    events.push(...[left_knee, right_knee].flatMap((k, i) => {
      const side = i === 0 ? 'left' : 'right';
      const list = [];
      if (k.timestamp_of_peak_deviation != null) list.push({ timestamp_seconds: k.timestamp_of_peak_deviation, type: `max_${side}_knee_deviation`, description: `Maximum ${side} knee medial/lateral deviation at ${round(k.timestamp_of_peak_deviation, 1)}s.` });
      return list;
    }));
    for (const [side, a] of [['left', ankles_feet.left], ['right', ankles_feet.right]]) for (const c of a.corrections) events.push({ timestamp_seconds: c.timestamp_seconds, type: `${side}_foot_correction`, description: `${side} ankle repositioning estimate (${c.direction}) at ${round(c.timestamp_seconds, 1)}s; not a confirmed step or floor touch.` });
    events.sort((a, b) => a.timestamp_seconds - b.timestamp_seconds);

    // ---- Thirds analysis (descriptive only, no causal claims) ----
    const windows = thirdsWindows(durationSeconds);
    const thirds = {};
    for (const metric of [['sway', mlSeries.raw], ['trunk_lean', trunkSeries.raw], ['pelvic_tilt', pelvicSeries.raw]]) {
      thirds[metric[0]] = { early: windowStats(metric[1], windows.early), middle: windowStats(metric[1], windows.middle), late: windowStats(metric[1], windows.late) };
    }
    const thirds_statements = [];
    if (thirds.sway.late.std != null && thirds.sway.early.std != null && thirds.sway.late.std > thirds.sway.early.std * 1.25) thirds_statements.push('Mediolateral sway variability increased during the final third of the trial compared with the first third.');
    if (thirds.trunk_lean.late.mean != null && thirds.trunk_lean.early.mean != null && Math.abs(thirds.trunk_lean.late.mean) > Math.abs(thirds.trunk_lean.early.mean) + 2) thirds_statements.push('Trunk lean magnitude increased during the final third of the trial compared with the first third.');

    // ---- Whole body overview ----
    const majorAsymmetry = [symmetry.knee_flexion, symmetry.knee_rom].filter(s => s.symmetry_index != null && s.symmetry_index > 15);
    const whole_body_overview = {
      trial_name: trialMeta.trial_name, duration_seconds: durationSeconds,
      tracking_quality: quality.tier, tracking_quality_fraction: quality.overall,
      overall_sway: balance_stability.total_sway_path,
      max_trunk_lean: trunk.max_deviation,
      pelvic_tilt_range: pelvis_hips.pelvic_tilt.range,
      left_knee_rom: left_knee.angle_range, right_knee_rom: right_knee.angle_range,
      foot_corrections_total: ankles_feet.left.correction_count + ankles_feet.right.correction_count,
      major_asymmetry_flagged: majorAsymmetry.length > 0,
    };

    return {
      trial_name: trialMeta.trial_name, stance: trialMeta.stance, tested_leg: trialMeta.tested_leg, eyes: trialMeta.eyes,
      camera_orientation: cameraOrientation,
      normalization: { scale_reference: scale.reference, scale_value_raw_units: round(scale.value) },
      measurement_quality: { ...quality, thresholds },
      whole_body_overview, balance_stability, shoulders, trunk, pelvis_hips,
      left_knee, right_knee, left_leg, right_leg, arms, ankles_feet, symmetry, events_timeline: events,
      thirds_analysis: { windows, metrics: thirds, statements: thirds_statements },
    };
  }

  function calculateEyesOpenClosedComparison(openResult, closedResult, label) {
    if (!openResult || !closedResult) return null;
    const pct = (a, b) => (a == null || b == null || a === 0) ? null : round(((b - a) / Math.abs(a)) * 100, 1);
    return {
      stance: label,
      sway_open: openResult.balance_stability.total_sway_path, sway_closed: closedResult.balance_stability.total_sway_path,
      sway_change_percent: pct(openResult.balance_stability.total_sway_path, closedResult.balance_stability.total_sway_path),
      sway_velocity_open: openResult.balance_stability.sway_velocity, sway_velocity_closed: closedResult.balance_stability.sway_velocity,
      sway_velocity_change_percent: pct(openResult.balance_stability.sway_velocity, closedResult.balance_stability.sway_velocity),
    };
  }

  function calculateLeftRightSingleLegComparison(leftResult, rightResult) {
    if (!leftResult || !rightResult) return null;
    return {
      sway_left: leftResult.balance_stability.total_sway_path, sway_right: rightResult.balance_stability.total_sway_path,
      corrections_left: (leftResult.ankles_feet.left.correction_count + leftResult.ankles_feet.right.correction_count),
      corrections_right: (rightResult.ankles_feet.left.correction_count + rightResult.ankles_feet.right.correction_count),
    };
  }

  function compareToBaseline(currentOverview, baselineOverview) {
    if (!baselineOverview) return null;
    const diff = (key) => (currentOverview[key] != null && baselineOverview[key] != null) ? round(currentOverview[key] - baselineOverview[key]) : null;
    return {
      overall_sway_change: diff('overall_sway'), max_trunk_lean_change: diff('max_trunk_lean'),
      pelvic_tilt_range_change: diff('pelvic_tilt_range'), foot_corrections_change: diff('foot_corrections_total'),
    };
  }

  // Deterministic, template-based movement summary -- describes measurable
  // co-occurrence only ("X happened around the same time as Y"), never
  // causal language ("X caused Y") or clinical inference. No AI call needed
  // for this; it's built directly from already-calculated values.
  function generateMovementSummary(result) {
    const statements = [...result.thirds_analysis.statements];
    const kneeEvents = [result.left_knee, result.right_knee]
      .map((k, i) => ({ side: i === 0 ? 'left' : 'right', t: k.timestamp_of_peak_deviation, mag: Math.max(Math.abs(k.peak_medial_deviation ?? 0), Math.abs(k.peak_lateral_deviation ?? 0)) }))
      .filter(e => e.t != null)
      .sort((a, b) => b.mag - a.mag);
    if (kneeEvents.length) {
      const e = kneeEvents[0];
      const window = 1.0;
      const nearbyTrunk = Math.abs((result.trunk.timestamp_of_max ?? -999) - e.t) <= window;
      const nearbyPelvis = result.pelvis_hips.pelvic_tilt.peaks?.max_timestamp != null && Math.abs(result.pelvis_hips.pelvic_tilt.peaks.max_timestamp - e.t) <= window;
      let sentence = `The trial's largest ${e.side}-knee medial/lateral deviation occurred at approximately ${round(e.t, 1)}s`;
      const co = [];
      if (nearbyTrunk) co.push('elevated trunk lean');
      if (nearbyPelvis) co.push('increased pelvic tilt');
      if (co.length) sentence += `, during the same period as ${co.join(' and ')}`;
      sentence += '.';
      statements.push(sentence);
    }
    if (!statements.length) statements.push('No large deviations, sway increases, or asymmetries stood out from this trial’s calculated measurements.');
    return statements;
  }

  // The AI layer must only see the calculated summary metrics (means, ranges,
  // peaks, symmetry, events, thirds-trend, movement_summary text) — never the
  // per-frame time series kept for the in-app charts/replay. Those arrays
  // (identified by key name, since they're the only array-shaped values in
  // this tree) are stripped from a deep copy before an interpreted result is
  // sent anywhere off-device.
  function stripTimeSeriesForAI(result) {
    if (!result || typeof result !== 'object') return result;
    const clone = JSON.parse(JSON.stringify(result));
    (function strip(node) {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return;
      delete node.samples;
      delete node.body_center_path;
      for (const key in node) strip(node[key]);
    })(clone);
    return clone;
  }

  global.Interpretation = { analyzeTrial, calculateEyesOpenClosedComparison, calculateLeftRightSingleLegComparison, compareToBaseline, generateMovementSummary, stripTimeSeriesForAI, REGION_LANDMARKS };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  if (typeof global.Biomech === 'undefined') global.Biomech = require('./biomechanics.js');
  module.exports = global.Interpretation;
}
