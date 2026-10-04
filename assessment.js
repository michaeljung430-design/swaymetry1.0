// Pure calculation layer for the six-condition, three-repetition assessment.
// No DOM access here -- this module only turns recorded samples into
// trial JSON, so it can be loaded in a browser or tested under Node.
(function (global) {
  const CONDITIONS = [
    { id: 'double_leg_eyes_open', trial_number: 1, trial_name: 'double_leg_eyes_open', stance: 'double_leg', tested_leg: null, eyes: 'open', label: 'Double-leg — Eyes Open', instruction: 'Stand with both feet comfortably apart. Look straight ahead.' },
    { id: 'double_leg_eyes_closed', trial_number: 2, trial_name: 'double_leg_eyes_closed', stance: 'double_leg', tested_leg: null, eyes: 'closed', label: 'Double-leg — Eyes Closed', instruction: 'Stand with both feet comfortably apart. Close your eyes once recording starts.' },
    { id: 'right_leg_eyes_open', trial_number: 3, trial_name: 'right_leg_eyes_open', stance: 'single_leg', tested_leg: 'right', eyes: 'open', label: 'Right Leg — Eyes Open', instruction: 'Stand on your right leg. Look straight ahead.' },
    { id: 'right_leg_eyes_closed', trial_number: 4, trial_name: 'right_leg_eyes_closed', stance: 'single_leg', tested_leg: 'right', eyes: 'closed', label: 'Right Leg — Eyes Closed', instruction: 'Stand on your right leg. Close your eyes once recording starts.' },
    { id: 'left_leg_eyes_open', trial_number: 5, trial_name: 'left_leg_eyes_open', stance: 'single_leg', tested_leg: 'left', eyes: 'open', label: 'Left Leg — Eyes Open', instruction: 'Stand on your left leg. Look straight ahead.' },
    { id: 'left_leg_eyes_closed', trial_number: 6, trial_name: 'left_leg_eyes_closed', stance: 'single_leg', tested_leg: 'left', eyes: 'closed', label: 'Left Leg — Eyes Closed', instruction: 'Stand on your left leg. Close your eyes once recording starts.' },
  ];

  let REPETITIONS = 3;
  let TRIAL_DURATION_SECONDS = 30;
  const TRIALS = [];
  function setProtocol({ repetitions = 3, durationSeconds = 30 } = {}) {
    if (![1, 2, 3, 4, 5].includes(repetitions) || ![5, 10, 20, 30, 45, 60].includes(durationSeconds)) throw new Error('Unsupported trial settings.');
    REPETITIONS = repetitions;
    TRIAL_DURATION_SECONDS = durationSeconds;
    TRIALS.splice(0, TRIALS.length, ...CONDITIONS.flatMap(condition => Array.from({ length: REPETITIONS }, (_, i) => ({
      ...condition,
      id: `${condition.id}_rep_${i + 1}`,
      trial_name: `${condition.trial_name}_rep_${i + 1}`,
      condition_id: condition.id,
      repetition: i + 1,
      trial_number: (condition.trial_number - 1) * REPETITIONS + i + 1,
      label: `${condition.label} · ${i + 1}/${REPETITIONS}`,
    }))));
  }
  setProtocol();

  // Every landmark MediaPipe's Pose model produces (33 points), not just the
  // subset used in balance calculations -- the Raw Results view preserves
  // every one of these per frame.
  const LANDMARK_INDEX = {
    nose: 0,
    left_eye_inner: 1, left_eye: 2, left_eye_outer: 3,
    right_eye_inner: 4, right_eye: 5, right_eye_outer: 6,
    left_ear: 7, right_ear: 8,
    mouth_left: 9, mouth_right: 10,
    left_shoulder: 11, right_shoulder: 12,
    left_elbow: 13, right_elbow: 14,
    left_wrist: 15, right_wrist: 16,
    left_pinky: 17, right_pinky: 18,
    left_index: 19, right_index: 20,
    left_thumb: 21, right_thumb: 22,
    left_hip: 23, right_hip: 24,
    left_knee: 25, right_knee: 26,
    left_ankle: 27, right_ankle: 28,
    left_heel: 29, right_heel: 30,
    left_foot_index: 31, right_foot_index: 32,
  };
  const FULL_BODY_LANDMARKS = ['left_shoulder', 'right_shoulder', 'left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_ankle', 'right_ankle'];
  const VISIBILITY_THRESHOLD = 0.45;

  const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  const stdDev = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(mean(a.map(v => (v - m) ** 2))); };
  const rms = a => a.length ? Math.sqrt(mean(a.map(x => x * x))) : null;
  const round = (v, d = 4) => v == null || Number.isNaN(v) || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d;
  const safeMax = a => a.length ? Math.max(...a) : null;
  const safeRange = a => a.length ? Math.max(...a) - Math.min(...a) : null;
  const deg = r => r * 180 / Math.PI;

  function landmarkVisible(l) { return !!l && l.confidence != null && l.confidence > VISIBILITY_THRESHOLD; }

  function fullBodyInFrame(landmarks) {
    if (!landmarks) return false;
    return FULL_BODY_LANDMARKS.every(name => landmarkVisible(landmarks[name]));
  }

  // Builds one landmark-frame record from a raw MediaPipe pose-landmark array.
  function captureLandmarkFrame(poseLandmarks, timestampSeconds) {
    const landmarks = {};
    for (const [name, idx] of Object.entries(LANDMARK_INDEX)) {
      const p = poseLandmarks && poseLandmarks[idx];
      landmarks[name] = p
        ? { x: p.x, y: p.y, z: p.z ?? null, confidence: p.visibility ?? null }
        : { x: null, y: null, z: null, confidence: null };
    }
    return { timestamp_seconds: timestampSeconds, landmarks };
  }

  // Builds one phone sample from a devicemotion event plus the latest known
  // orientation reading (deviceorientation fires independently).
  function capturePhoneSample(motionEvent, timestampSeconds, latestOrientation) {
    const a = motionEvent.acceleration || motionEvent.accelerationIncludingGravity || null;
    const r = motionEvent.rotationRate || null;
    return {
      timestamp_seconds: timestampSeconds,
      accelerometer: a ? { x: numOrNull(a.x), y: numOrNull(a.y), z: numOrNull(a.z) } : { x: null, y: null, z: null },
      gyroscope: r ? { x: numOrNull(r.alpha), y: numOrNull(r.beta), z: numOrNull(r.gamma) } : { x: null, y: null, z: null },
      orientation: latestOrientation ? { ...latestOrientation } : { roll: null, pitch: null, yaw: null },
    };
  }
  function numOrNull(v) { return typeof v === 'number' && !Number.isNaN(v) ? v : null; }

  function midpoint(a, b) { if (a.x == null || b.x == null) return { x: null, y: null }; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
  function tilt(a, b) { if (a.x == null || b.x == null) return null; return deg(Math.atan2(b.y - a.y, b.x - a.x)); }
  function verticalDeviation(a, b) { if (a.x == null || b.x == null) return null; return deg(Math.atan2(b.x - a.x, a.y - b.y)); }
  function jointAngle(a, b, c) { if (a.x == null || b.x == null || c.x == null) return null; const d1 = Math.hypot(a.x - b.x, a.y - b.y), d2 = Math.hypot(c.x - b.x, c.y - b.y); if (!d1 || !d2) return null; return deg(Math.acos(Math.max(-1, Math.min(1, ((a.x - b.x) * (c.x - b.x) + (a.y - b.y) * (c.y - b.y)) / (d1 * d2))))); }

  // Signed, image-plane knee bend: positive when the knee projects toward the
  // opposite hip (valgus-like), negative when it projects away (varus-like).
  // This is a 2D screening proxy, not an anatomical frontal-plane joint angle.
  function frontalKneeDeviation(hip, knee, ankle, oppositeHip, width, height) {
    if (![hip, knee, ankle, oppositeHip].every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y) && (p.confidence ?? p.visibility ?? 0) > VISIBILITY_THRESHOLD) || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    const h = { x: hip.x * width, y: hip.y * height };
    const k = { x: knee.x * width, y: knee.y * height };
    const a = { x: ankle.x * width, y: ankle.y * height };
    const otherX = oppositeHip.x * width;
    if (Math.abs(otherX - h.x) < width * 0.025 || Math.abs(a.y - h.y) < height * 0.08) return null;
    const interior = jointAngle(h, k, a);
    if (interior == null) return null;
    const projectedX = h.x + (a.x - h.x) * (k.y - h.y) / (a.y - h.y);
    const towardOtherHip = (k.x - projectedX) * Math.sign(otherX - h.x);
    return round((180 - interior) * Math.sign(towardOtherHip), 2);
  }

  // Groups a run of consecutive threshold-exceeding samples into a single
  // event at its peak, instead of emitting one event per frame.
  function detectThresholdEvents(series, threshold, type, describe) {
    const events = [];
    let active = null;
    for (const point of series) {
      if (point.value == null) continue;
      if (Math.abs(point.value) >= threshold) {
        if (!active || Math.abs(point.value) > Math.abs(active.peak)) active = { peak: point.value, t: point.timestamp_seconds };
      } else if (active) {
        events.push({ timestamp_seconds: active.t, type, description: describe(active.peak) });
        active = null;
      }
    }
    if (active) events.push({ timestamp_seconds: active.t, type, description: describe(active.peak) });
    return events;
  }

  function computePhoneMetrics(samples) {
    const valid = samples.filter(s => s.accelerometer && s.accelerometer.x != null && s.accelerometer.y != null && s.accelerometer.z != null);
    const missingPercent = samples.length ? round(100 * (1 - valid.length / samples.length), 1) : 100;
    if (valid.length < 5) {
      return { metrics: nullPhoneMetrics(), events: [], quality: 0, missing_percent: missingPercent };
    }
    const x = valid.map(s => s.accelerometer.x), y = valid.map(s => s.accelerometer.y), z = valid.map(s => s.accelerometer.z);
    const mag = valid.map((s, i) => Math.hypot(x[i], y[i], z[i]));
    const meanAbs = a => mean(a.map(Math.abs));
    const lateralRange = Math.max(...x) - Math.min(...x);
    const apRange = Math.max(...z) - Math.min(...z);
    const velocitySeries = [];
    for (let i = 1; i < valid.length; i++) {
      const dt = Math.max(0.01, valid[i].timestamp_seconds - valid[i - 1].timestamp_seconds);
      velocitySeries.push({ timestamp_seconds: valid[i].timestamp_seconds, value: Math.abs(mag[i] - mag[i - 1]) / dt });
    }
    const velocities = velocitySeries.map(v => v.value);
    const magMean = mean(mag), magStd = stdDev(mag);
    const velMean = mean(velocities), velStd = stdDev(velocities);
    const magSeries = valid.map((s, i) => ({ timestamp_seconds: s.timestamp_seconds, value: mag[i] }));
    const correctionEvents = detectThresholdEvents(magSeries, magMean + 2 * magStd, 'large_corrective_movement', v => `Large sway movement detected (acceleration magnitude ${v.toFixed(2)} m/s²).`);
    const suddenAccelEvents = detectThresholdEvents(velocitySeries, velMean + 3 * velStd, 'sudden_acceleration', () => 'Sudden change in acceleration detected.');
    const balanceLossEvents = detectThresholdEvents(magSeries, magMean + 4 * magStd, 'possible_balance_loss', v => `Large, abrupt movement detected (magnitude ${v.toFixed(2)} m/s²) -- possible balance loss.`);
    // Axis signs are device coordinates, not anatomical directions without
    // an orientation calibration. Do not assign left/right or front/back.
    const dominant_direction = lateralRange >= apRange ? 'device x axis' : 'device z axis';
    return {
      metrics: {
        mean_lateral_sway: round(meanAbs(x)),
        max_lateral_sway: round(Math.max(...x.map(Math.abs))),
        lateral_sway_range: round(lateralRange),
        mean_anterior_posterior_sway: round(meanAbs(z)),
        max_anterior_posterior_sway: round(Math.max(...z.map(Math.abs))),
        anterior_posterior_sway_range: round(apRange),
        total_sway: round(rms(mag)),
        mean_sway_velocity: round(velMean),
        max_sway_velocity: round(Math.max(...velocities, 0)),
        dominant_direction,
        large_corrections: correctionEvents.length,
        sway_variability: round(magStd),
      },
      events: [...correctionEvents, ...suddenAccelEvents, ...balanceLossEvents],
      quality: round(valid.length / samples.length, 3),
      missing_percent: missingPercent,
    };
  }
  function nullPhoneMetrics() {
    return { mean_lateral_sway: null, max_lateral_sway: null, lateral_sway_range: null, mean_anterior_posterior_sway: null, max_anterior_posterior_sway: null, anterior_posterior_sway_range: null, total_sway: null, mean_sway_velocity: null, max_sway_velocity: null, dominant_direction: null, large_corrections: null, sway_variability: null };
  }

  function computeCameraMetrics(frames, trial) {
    const rows = frames.map(f => {
      const l = f.landmarks;
      const hip = midpoint(l.left_hip, l.right_hip);
      const shoulder = midpoint(l.left_shoulder, l.right_shoulder);
      const ankleGap = (l.left_ankle.x != null && l.right_ankle.x != null) ? Math.hypot(l.left_ankle.x - l.right_ankle.x, l.left_ankle.y - l.right_ankle.y) : null;
      return {
        t: f.timestamp_seconds,
        hip, shoulder,
        trunk: verticalDeviation(hip, shoulder) != null ? Math.abs(verticalDeviation(hip, shoulder)) : null,
        trunkSigned: verticalDeviation(hip, shoulder),
        pelvisTilt: tilt(l.left_hip, l.right_hip),
        shoulderTilt: tilt(l.left_shoulder, l.right_shoulder),
        head: (landmarkVisible(l.nose) && shoulder.x != null) ? Math.abs(verticalDeviation(shoulder, l.nose)) : null,
        leftKnee: jointAngle(l.left_hip, l.left_knee, l.left_ankle),
        rightKnee: jointAngle(l.right_hip, l.right_knee, l.right_ankle),
        leftFrontalKnee: frontalKneeDeviation(l.left_hip, l.left_knee, l.left_ankle, l.right_hip, f.image_width, f.image_height),
        rightFrontalKnee: frontalKneeDeviation(l.right_hip, l.right_knee, l.right_ankle, l.left_hip, f.image_width, f.image_height),
        leftKneeX: l.left_knee.x, rightKneeX: l.right_knee.x,
        leftHipX: l.left_hip.x, leftAnkleX: l.left_ankle.x,
        rightHipX: l.right_hip.x, rightAnkleX: l.right_ankle.x,
        leftAnkle: l.left_ankle, rightAnkle: l.right_ankle,
        ankleGap,
        visible: fullBodyInFrame(l),
      };
    });
    const visibleRows = rows.filter(r => r.visible);
    const missingPercent = frames.length ? round(100 * (1 - visibleRows.length / frames.length), 1) : 100;
    if (visibleRows.length < 5) {
      return { posture: nullCameraMetrics(), events: [], singleLeg: nullSingleLegMetrics(trial), quality: 0, missing_percent: missingPercent };
    }

    const col = key => visibleRows.map(r => r[key]).filter(v => v != null);
    const numeric = key => visibleRows.map(r => r[key]);
    const trunkVals = col('trunk'), pelvisVals = col('pelvisTilt').map(Math.abs), shoulderVals = col('shoulderTilt').map(Math.abs), headVals = col('head');
    const leftKneeVals = col('leftKnee'), rightKneeVals = col('rightKnee');
    const leftFrontalKneeVals = col('leftFrontalKnee'), rightFrontalKneeVals = col('rightFrontalKnee');
    const hipX = visibleRows.map(r => r.hip.x).filter(v => v != null);
    const hipY = visibleRows.map(r => r.hip.y).filter(v => v != null);

    const trunkSignedVals = visibleRows.map(r => r.trunkSigned).filter(v => v != null);
    const pelvisSignedVals = visibleRows.map(r => r.pelvisTilt).filter(v => v != null);
    const shoulderSignedVals = visibleRows.map(r => r.shoulderTilt).filter(v => v != null);

    const bodyWidthRef = mean(visibleRows.map(r => (r.leftHipX != null && r.rightHipX != null) ? Math.abs(r.leftHipX - r.rightHipX) : null).filter(v => v != null)) || 0.15;

    const leftKneeDisp = visibleRows.map(r => (r.leftKneeX != null && r.leftHipX != null && r.leftAnkleX != null) ? r.leftKneeX - (r.leftHipX + r.leftAnkleX) / 2 : null).filter(v => v != null);
    const rightKneeDisp = visibleRows.map(r => (r.rightKneeX != null && r.rightHipX != null && r.rightAnkleX != null) ? r.rightKneeX - (r.rightHipX + r.rightAnkleX) / 2 : null).filter(v => v != null);

    const stanceWidths = visibleRows.map(r => r.ankleGap).filter(v => v != null);
    const leftAnkleX = visibleRows.map(r => r.leftAnkle.x).filter(v => v != null);
    const leftAnkleY = visibleRows.map(r => r.leftAnkle.y).filter(v => v != null);
    const rightAnkleX = visibleRows.map(r => r.rightAnkle.x).filter(v => v != null);
    const rightAnkleY = visibleRows.map(r => r.rightAnkle.y).filter(v => v != null);
    const leftFootMovement = (Math.max(...leftAnkleX) - Math.min(...leftAnkleX)) + (Math.max(...leftAnkleY) - Math.min(...leftAnkleY));
    const rightFootMovement = (Math.max(...rightAnkleX) - Math.min(...rightAnkleX)) + (Math.max(...rightAnkleY) - Math.min(...rightAnkleY));

    const trunkMean = mean(trunkSignedVals), trunkStd = stdDev(trunkSignedVals);
    const trunkSeries = visibleRows.map(r => ({ timestamp_seconds: r.t, value: r.trunk }));
    const trunkEvents = detectThresholdEvents(trunkSeries, mean(trunkVals) + 2 * stdDev(trunkVals), 'major_trunk_correction', v => `Large trunk lean correction detected (${v.toFixed(1)}°).`);
    const pelvisSeries = visibleRows.map(r => ({ timestamp_seconds: r.t, value: r.pelvisTilt != null ? Math.abs(r.pelvisTilt) : null }));
    const pelvisEvents = detectThresholdEvents(pelvisSeries, mean(pelvisVals) + 2 * stdDev(pelvisVals), 'major_pelvic_correction', v => `Large pelvic tilt correction detected (${v.toFixed(1)}°).`);

    const hipXSeries = visibleRows.map(r => ({ timestamp_seconds: r.t, value: r.hip.x }));
    const hipXMean = mean(hipX), hipXStd = stdDev(hipX);
    const swaySeries = visibleRows.map(r => ({ timestamp_seconds: r.t, value: r.hip.x != null ? r.hip.x - hipXMean : null }));
    const largeLeftSway = detectThresholdEvents(swaySeries, hipXStd * 2, 'large_left_sway', () => 'Large leftward body shift detected.');
    // detectThresholdEvents uses Math.abs internally so left/right split needs separate signed passes
    const leftEvents = [], rightEvents = [];
    {
      let active = null;
      for (const p of swaySeries) {
        if (p.value == null) continue;
        if (p.value <= -2 * hipXStd) { if (!active || p.value < active.peak) active = { peak: p.value, t: p.timestamp_seconds }; }
        else if (active) { leftEvents.push({ timestamp_seconds: active.t, type: 'large_left_sway', description: 'Large leftward body shift detected.' }); active = null; }
      }
      if (active) leftEvents.push({ timestamp_seconds: active.t, type: 'large_left_sway', description: 'Large leftward body shift detected.' });
      active = null;
      for (const p of swaySeries) {
        if (p.value == null) continue;
        if (p.value >= 2 * hipXStd) { if (!active || p.value > active.peak) active = { peak: p.value, t: p.timestamp_seconds }; }
        else if (active) { rightEvents.push({ timestamp_seconds: active.t, type: 'large_right_sway', description: 'Large rightward body shift detected.' }); active = null; }
      }
      if (active) rightEvents.push({ timestamp_seconds: active.t, type: 'large_right_sway', description: 'Large rightward body shift detected.' });
    }

    const trackingLossEvents = [];
    { let gapStart = null; for (const r of rows) { if (!r.visible) { if (gapStart == null) gapStart = r.t; } else if (gapStart != null) { trackingLossEvents.push({ timestamp_seconds: gapStart, type: 'temporary_pose_tracking_loss', description: 'Body tracking was lost briefly during the trial.' }); gapStart = null; } } if (gapStart != null) trackingLossEvents.push({ timestamp_seconds: gapStart, type: 'temporary_pose_tracking_loss', description: 'Body tracking was lost briefly during the trial.' }); }

    // Single-leg specific: detect the non-tested foot touching down near the stance foot.
    let singleLeg = nullSingleLegMetrics(trial);
    const footEvents = [];
    if (trial && trial.stance === 'single_leg' && stanceWidths.length) {
      const raisedIsLeft = trial.tested_leg === 'right'; // testing the right leg means the LEFT foot is raised
      const raisedAnkleKey = raisedIsLeft ? 'leftAnkle' : 'rightAnkle';
      const stanceAnkleKey = raisedIsLeft ? 'rightAnkle' : 'leftAnkle';
      const gapVals = visibleRows.map(r => r.ankleGap).filter(v => v != null);
      const touchdownThreshold = Math.max(0.02, (mean(gapVals) || bodyWidthRef) * 0.35);
      const gapSeries = visibleRows.map(r => ({ timestamp_seconds: r.t, value: r.ankleGap != null ? touchdownThreshold - r.ankleGap : null }));
      const touchdownRuns = detectThresholdEvents(gapSeries, 0.00001, 'foot_touchdown', () => 'Opposite foot touched down during single-leg stance.');
      // Re-derive actual start/end + duration for touchdown runs (detectThresholdEvents only gives the peak instant).
      let active = null;
      const touchdownIntervals = [];
      for (const r of visibleRows) {
        const down = r.ankleGap != null && r.ankleGap < touchdownThreshold;
        if (down) { if (!active) active = { start: r.t, end: r.t }; else active.end = r.t; }
        else if (active) { touchdownIntervals.push(active); active = null; }
      }
      if (active) touchdownIntervals.push(active);
      const minEventDuration = 0.15;
      const realTouchdowns = touchdownIntervals.filter(iv => iv.end - iv.start >= minEventDuration);
      for (const iv of realTouchdowns) footEvents.push({ timestamp_seconds: round(iv.start, 2), type: 'foot_touchdown', description: 'Opposite foot touched down during single-leg stance.' });
      const touchdownDuration = realTouchdowns.reduce((s, iv) => s + (iv.end - iv.start), 0);
      const testedKneeVals = trial.tested_leg === 'right' ? rightKneeVals : leftKneeVals;
      const testedKneeDisp = trial.tested_leg === 'right' ? rightKneeDisp : leftKneeDisp;
      singleLeg = {
        applicable: true,
        tested_leg: trial.tested_leg,
        successful_stance_duration: round(Math.max(0, TRIAL_DURATION_SECONDS - touchdownDuration), 2),
        opposite_foot_touchdowns: realTouchdowns.length,
        touchdown_duration: round(touchdownDuration, 2),
        tested_leg_knee_movement: round(stdDev(testedKneeVals)),
        tested_leg_knee_displacement: round(stdDev(testedKneeDisp)),
        trunk_compensation: round(trunkStd),
        pelvic_compensation: round(stdDev(pelvisSignedVals)),
        major_balance_corrections: trunkEvents.length + pelvisEvents.length,
      };
    }

    const leftKneeVariability = stdDev(leftKneeVals), rightKneeVariability = stdDev(rightKneeVals);
    const asymmetry = {
      knee_variability_difference: round(Math.abs(leftKneeVariability - rightKneeVariability)),
      foot_movement_difference: round(Math.abs(leftFootMovement - rightFootMovement)),
    };

    return {
      posture: {
        trunk: { mean_lean: round(mean(trunkVals)), max_lean: round(Math.max(...trunkVals)), dominant_direction: mean(trunkSignedVals) >= 0 ? 'right' : 'left', movement_variability: round(trunkStd), sway_range: round(Math.max(...trunkSignedVals) - Math.min(...trunkSignedVals)) },
        shoulders: { mean_tilt: round(mean(shoulderVals)), max_tilt: round(Math.max(...shoulderVals)), dominant_direction: mean(shoulderSignedVals) >= 0 ? 'right' : 'left', movement_variability: round(stdDev(shoulderSignedVals)) },
        pelvis: { mean_tilt: round(mean(pelvisVals)), max_tilt: round(Math.max(...pelvisVals)), dominant_direction: mean(pelvisSignedVals) >= 0 ? 'right' : 'left', lateral_hip_displacement: round(Math.max(...hipX) - Math.min(...hipX)), movement_variability: round(stdDev(pelvisSignedVals)) },
        head: { mean_tilt: round(mean(headVals)), max_tilt: round(safeMax(headVals)), movement_range: round(safeRange(headVals)) },
        left_knee: { mean_angle: round(mean(leftKneeVals)), movement_variability: round(leftKneeVariability), medial_lateral_displacement: round(stdDev(leftKneeDisp)), mean_frontal_deviation_deg: round(mean(leftFrontalKneeVals), 2), peak_frontal_deviation_deg: round(safeMax(leftFrontalKneeVals.map(Math.abs)), 2) },
        right_knee: { mean_angle: round(mean(rightKneeVals)), movement_variability: round(rightKneeVariability), medial_lateral_displacement: round(stdDev(rightKneeDisp)), mean_frontal_deviation_deg: round(mean(rightFrontalKneeVals), 2), peak_frontal_deviation_deg: round(safeMax(rightFrontalKneeVals.map(Math.abs)), 2) },
        feet: { stance_width: round(mean(stanceWidths)), left_foot_movement: round(leftFootMovement), right_foot_movement: round(rightFootMovement) },
        whole_body: {
          lateral_movement: round(Math.max(...hipX) - Math.min(...hipX)),
          anterior_posterior_movement: round(Math.max(...hipY) - Math.min(...hipY)),
          asymmetry,
          postural_corrections: trunkEvents.length + pelvisEvents.length,
          major_instability_events: trunkEvents.length + pelvisEvents.length + leftEvents.length + rightEvents.length,
        },
      },
      events: [...trunkEvents, ...pelvisEvents, ...leftEvents, ...rightEvents, ...footEvents, ...trackingLossEvents],
      singleLeg,
      quality: round(visibleRows.length / frames.length, 3),
      missing_percent: missingPercent,
    };
  }
  function nullCameraMetrics() {
    const nullBlock = extra => ({ mean_lean: null, max_lean: null, dominant_direction: null, movement_variability: null, ...extra });
    return {
      trunk: nullBlock({ sway_range: null }), shoulders: nullBlock({}),
      pelvis: { mean_tilt: null, max_tilt: null, dominant_direction: null, lateral_hip_displacement: null, movement_variability: null },
      head: { mean_tilt: null, max_tilt: null, movement_range: null },
      left_knee: { mean_angle: null, movement_variability: null, medial_lateral_displacement: null, mean_frontal_deviation_deg: null, peak_frontal_deviation_deg: null },
      right_knee: { mean_angle: null, movement_variability: null, medial_lateral_displacement: null, mean_frontal_deviation_deg: null, peak_frontal_deviation_deg: null },
      feet: { stance_width: null, left_foot_movement: null, right_foot_movement: null },
      whole_body: { lateral_movement: null, anterior_posterior_movement: null, asymmetry: null, postural_corrections: null, major_instability_events: null },
    };
  }
  function nullSingleLegMetrics(trial) {
    return { applicable: !!(trial && trial.stance === 'single_leg'), tested_leg: trial ? trial.tested_leg : null, successful_stance_duration: null, opposite_foot_touchdowns: null, touchdown_duration: null, tested_leg_knee_movement: null, tested_leg_knee_displacement: null, trunk_compensation: null, pelvic_compensation: null, major_balance_corrections: null };
  }

  function buildTrialRecord({ trial, sessionId, startedAt, endedAt, phoneSamples, cameraFrames }) {
    const phone = computePhoneMetrics(phoneSamples);
    const camera = computeCameraMetrics(cameraFrames, trial);
    const events = [...phone.events, ...camera.events].sort((a, b) => a.timestamp_seconds - b.timestamp_seconds);
    return {
      trial_id: `${sessionId}_${trial.id}`,
      trial_number: trial.trial_number,
      trial_name: trial.trial_name,
      condition_id: trial.condition_id || trial.trial_name,
      repetition: trial.repetition || 1,
      stance: trial.stance,
      tested_leg: trial.tested_leg,
      eyes: trial.eyes,
      duration_seconds: TRIAL_DURATION_SECONDS,
      status: 'completed',
      started_at: startedAt,
      ended_at: endedAt,
      phone_balance: phone.metrics,
      measurement_notes: {
        phone_total_sway: 'RMS acceleration magnitude in m/s²; not displacement or force-plate center of pressure.',
        phone_mean_sway_velocity: 'Mean absolute derivative of acceleration magnitude in m/s³ (jerk proxy); not body velocity.',
        camera_angles: '2D image-plane angles; not equivalent to 3D laboratory joint rotations.',
        camera_ap: 'Image vertical coordinate; not anatomical anterior-posterior displacement.',
      },
      camera_posture: camera.posture,
      single_leg_metrics: camera.singleLeg,
      events,
      data_quality: {
        camera_tracking_quality: camera.quality,
        phone_tracking_quality: phone.quality,
        missing_camera_data_percent: camera.missing_percent,
        missing_phone_data_percent: phone.missing_percent,
      },
    };
  }

  function diff(a, b) { if (a == null || b == null) return null; return round(b - a); }
  function compareTrials(before, after, label) {
    if (!before || !after) return null;
    return {
      comparison: label,
      sway_change: diff(before.phone_balance.total_sway, after.phone_balance.total_sway),
      sway_velocity_change: diff(before.phone_balance.mean_sway_velocity, after.phone_balance.mean_sway_velocity),
      trunk_lean_change: diff(before.camera_posture.trunk.mean_lean, after.camera_posture.trunk.mean_lean),
      pelvic_tilt_change: diff(before.camera_posture.pelvis.mean_tilt, after.camera_posture.pelvis.mean_tilt),
      corrective_movement_change: diff(before.phone_balance.large_corrections, after.phone_balance.large_corrections),
      touchdown_change: (before.single_leg_metrics.opposite_foot_touchdowns != null && after.single_leg_metrics.opposite_foot_touchdowns != null) ? after.single_leg_metrics.opposite_foot_touchdowns - before.single_leg_metrics.opposite_foot_touchdowns : null,
    };
  }

  function computeComparisons(trialsById) {
    return {
      double_leg_open_vs_closed: compareTrials(trialsById.double_leg_eyes_open, trialsById.double_leg_eyes_closed, 'double_leg_open_vs_closed'),
      right_leg_open_vs_closed: compareTrials(trialsById.right_leg_eyes_open, trialsById.right_leg_eyes_closed, 'right_leg_open_vs_closed'),
      left_leg_open_vs_closed: compareTrials(trialsById.left_leg_eyes_open, trialsById.left_leg_eyes_closed, 'left_leg_open_vs_closed'),
      right_vs_left: compareRightLeft(trialsById),
    };
  }
  function compareRightLeft(trialsById) {
    const right = [trialsById.right_leg_eyes_open, trialsById.right_leg_eyes_closed].filter(Boolean);
    const left = [trialsById.left_leg_eyes_open, trialsById.left_leg_eyes_closed].filter(Boolean);
    if (!right.length || !left.length) return null;
    const avg = (list, get) => { const vals = list.map(get).filter(v => v != null); return vals.length ? mean(vals) : null; };
    return {
      sway_difference: diff(avg(left, t => t.phone_balance.total_sway), avg(right, t => t.phone_balance.total_sway)),
      corrections_difference: diff(avg(left, t => t.phone_balance.large_corrections), avg(right, t => t.phone_balance.large_corrections)),
      touchdown_difference: diff(avg(left, t => t.single_leg_metrics.opposite_foot_touchdowns), avg(right, t => t.single_leg_metrics.opposite_foot_touchdowns)),
      knee_control_difference: diff(avg(left, t => t.camera_posture.left_knee.movement_variability), avg(right, t => t.camera_posture.right_knee.movement_variability)),
      stance_duration_difference: diff(avg(left, t => t.single_leg_metrics.successful_stance_duration), avg(right, t => t.single_leg_metrics.successful_stance_duration)),
      trunk_compensation_difference: diff(avg(left, t => t.single_leg_metrics.trunk_compensation), avg(right, t => t.single_leg_metrics.trunk_compensation)),
    };
  }

  function buildAssessmentJSON({ assessmentId, patientId, date, assessmentNumber, trials }) {
    const conditionMeans = {};
    for (const condition of CONDITIONS) {
      const group = trials.filter(t => (t.condition_id || t.trial_name) === condition.id && t.protocol_valid !== false);
      const avg = get => { const values = group.map(get).filter(Number.isFinite); return values.length ? round(mean(values)) : null; };
      const repeatability = get => {
        const values = group.map(get).filter(Number.isFinite);
        if (values.length < 2) return { n: values.length, mean: values.length ? round(mean(values)) : null, sd: null, cv_percent: null };
        const m = mean(values);
        const sd = Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
        return { n: values.length, mean: round(m), sd: round(sd), cv_percent: m === 0 ? null : round(Math.abs(100 * sd / m), 2) };
      };
      conditionMeans[condition.id] = {
        condition_id: condition.id,
        completed_repetitions: group.length,
        excluded_protocol_error_repetitions: trials.filter(t => (t.condition_id || t.trial_name) === condition.id && t.protocol_valid === false).length,
        phone_balance: {
          total_sway: avg(t => t.phone_balance?.total_sway),
          mean_sway_velocity: avg(t => t.phone_balance?.mean_sway_velocity),
          large_corrections: avg(t => t.phone_balance?.large_corrections),
        },
        camera_posture: {
          trunk: { mean_lean: avg(t => t.camera_posture?.trunk?.mean_lean) },
          pelvis: { mean_tilt: avg(t => t.camera_posture?.pelvis?.mean_tilt) },
          left_knee: { movement_variability: avg(t => t.camera_posture?.left_knee?.movement_variability), mean_frontal_deviation_deg: avg(t => t.camera_posture?.left_knee?.mean_frontal_deviation_deg) },
          right_knee: { movement_variability: avg(t => t.camera_posture?.right_knee?.movement_variability), mean_frontal_deviation_deg: avg(t => t.camera_posture?.right_knee?.mean_frontal_deviation_deg) },
        },
        side_camera: {
          mean_knee_flexion_proxy_deg: avg(t => t.side_camera?.mean_knee_flexion_proxy_deg),
          mean_hip_flexion_proxy_deg: avg(t => t.side_camera?.mean_hip_flexion_proxy_deg),
          mean_trunk_lean_deg: avg(t => t.side_camera?.mean_trunk_lean_deg),
        },
        single_leg_metrics: {
          opposite_foot_touchdowns: avg(t => t.single_leg_metrics?.opposite_foot_touchdowns),
          successful_stance_duration: avg(t => t.single_leg_metrics?.successful_stance_duration),
          trunk_compensation: avg(t => t.single_leg_metrics?.trunk_compensation),
        },
        within_session_repeatability: {
          phone_rms_acceleration_m_s2: repeatability(t => t.phone_balance?.total_sway),
          camera_image_plane_path_normalized_units: repeatability(t => t.interpreted?.balance_stability?.total_sway_path),
          camera_trunk_lean_degrees: repeatability(t => t.camera_posture?.trunk?.mean_lean),
          side_knee_flexion_proxy_degrees: repeatability(t => t.side_camera?.mean_knee_flexion_proxy_deg),
        },
      };
    }
    return {
      assessment: { assessment_id: assessmentId, patient_id: patientId || null, date, assessment_number: assessmentNumber ?? null },
      protocol: { trial_duration_seconds: TRIAL_DURATION_SECONDS, number_of_conditions: CONDITIONS.length, repetitions_per_condition: REPETITIONS, number_of_trials: TRIALS.length },
      trials,
      condition_means: conditionMeans,
      comparisons: computeComparisons(conditionMeans),
      historical_comparison: { baseline_available: false, previous_assessment_available: false, changes: [] },
    };
  }

  global.Assessment = {
    TRIALS, CONDITIONS, get REPETITIONS() { return REPETITIONS; }, get TRIAL_DURATION_SECONDS() { return TRIAL_DURATION_SECONDS; }, setProtocol, LANDMARK_INDEX, FULL_BODY_LANDMARKS,
    fullBodyInFrame, landmarkVisible, frontalKneeDeviation,
    captureLandmarkFrame, capturePhoneSample,
    computePhoneMetrics, computeCameraMetrics, buildTrialRecord,
    computeComparisons, buildAssessmentJSON,
  };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) module.exports = (typeof window !== 'undefined' ? window.Assessment : globalThis.Assessment);
