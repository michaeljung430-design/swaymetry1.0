// Renders the Raw Results / Interpreted Results sub-tabs inside the Results
// page. Depends on Assessment, Biomech, Interpretation, RawStore already
// being loaded, and on a `$` (getElementById) + `escapeHtml` helper being
// present in the enclosing page scope (passed in via ResultsUI.init).
(function (global) {
  let $, escapeHtml, getAssessment = () => null, currentTrialName = null, rawCache = null, replayState = null, rawViewGeneration = 0;

  // ---- Small render helpers ----
  function metricGrid(items) {
    return `<div class="metric-grid">${items.map(([label, value, flag]) => `<div class="metric-card${flag ? ' flag' : ''}"><small>${escapeHtml(label)}</small><b>${value == null ? '—' : escapeHtml(String(value))}</b></div>`).join('')}</div>`;
  }
  function fmt(v, unit = '', d = 1) { return v == null ? '—' : `${v.toFixed(d)}${unit}`; }
  const FACE_POINTS = new Set(['nose','left_eye_inner','left_eye','left_eye_outer','right_eye_inner','right_eye','right_eye_outer','left_ear','right_ear','mouth_left','mouth_right']);
  function withoutHeadData(value) {
    if (Array.isArray(value)) return value.map(withoutHeadData);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => !FACE_POINTS.has(key) && key !== 'head' && key !== 'head_neck').map(([key, item]) => [key, withoutHeadData(item)]));
  }

  // ---- Hand-rolled canvas time-series chart with hover + click-to-seek ----
  function drawChart(canvas, seriesList, { onSeek, yLabel = '' } = {}) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const allPts = seriesList.flatMap(s => s.samples || []);
    const allT = allPts.map(p => p.t);
    const allV = allPts.map(p => p.value).filter(v => v != null);
    if (!allT.length || !allV.length) { ctx.fillStyle = '#707c8c'; ctx.font = '12px system-ui'; ctx.fillText('No data available for this trial.', 10, h / 2); return; }
    const tMin = 0, tMax = Math.max(...allT, 1);
    const vMin = Math.min(...allV), vMax = Math.max(...allV);
    const vRange = (vMax - vMin) || 1;
    const pad = { l: 46, r: 12, t: 10, b: 22 };
    const plotW = w - pad.l - pad.r, plotH = h - pad.t - pad.b;
    const xOf = t => pad.l + (t - tMin) / (tMax - tMin || 1) * plotW;
    const yOf = v => pad.t + plotH - (v - vMin) / vRange * plotH;
    ctx.strokeStyle = '#e6e9ee'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pad.l, pad.t); ctx.lineTo(pad.l, pad.t + plotH); ctx.lineTo(pad.l + plotW, pad.t + plotH); ctx.stroke();
    ctx.fillStyle = '#707c8c'; ctx.font = '10px system-ui';
    ctx.fillText(vMax.toFixed(1), 2, pad.t + 8); ctx.fillText(vMin.toFixed(1), 2, pad.t + plotH);
    ctx.fillText('0s', pad.l, h - 6); ctx.fillText(tMax.toFixed(0) + 's', pad.l + plotW - 18, h - 6);
    if (yLabel) { ctx.save(); ctx.translate(10, pad.t + plotH / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText(yLabel, 0, 0); ctx.restore(); }
    seriesList.forEach(s => {
      ctx.strokeStyle = s.color || '#0f9488'; ctx.lineWidth = 1.6; ctx.beginPath();
      let started = false;
      (s.samples || []).forEach(p => { if (p.value == null) { started = false; return; } const x = xOf(p.t), y = yOf(p.value); if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y); });
      ctx.stroke();
    });
    canvas._chartMeta = { xOf, tMin, tMax, pad, plotW };
    canvas.onmousemove = e => {
      const rect = canvas.getBoundingClientRect();
      const px = (e.clientX - rect.left) * (canvas.width / rect.width);
      const t = Math.max(tMin, Math.min(tMax, tMin + (px - pad.l) / plotW * (tMax - tMin)));
      canvas.title = `t=${t.toFixed(2)}s`;
      if (onSeek) onSeek(t, false);
    };
    canvas.onclick = e => {
      const rect = canvas.getBoundingClientRect();
      const px = (e.clientX - rect.left) * (canvas.width / rect.width);
      const t = Math.max(tMin, Math.min(tMax, tMin + (px - pad.l) / plotW * (tMax - tMin)));
      if (onSeek) onSeek(t, true);
    };
  }
  function chartCard(title, seriesList, unit) {
    const id = `chart-${Math.random().toString(36).slice(2)}`;
    setTimeout(() => { const c = $(id); if (c) drawChart(c, seriesList, { onSeek: (t, click) => { if (click) seekReplay(t); }, yLabel: unit }); }, 0);
    return `<div class="chart-block"><small>${escapeHtml(title)}</small><canvas id="${id}" width="640" height="150" style="width:100%;height:150px"></canvas></div>`;
  }
  function swayPathCard(points) {
    const id = `chart-${Math.random().toString(36).slice(2)}`;
    setTimeout(() => {
      const canvas = $(id); if (!canvas) return;
      const ctx = canvas.getContext('2d'); const w = canvas.width, h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      if (!points.length) { ctx.fillStyle = '#707c8c'; ctx.fillText('No data', 10, h / 2); return; }
      const xs = points.map(p => p.x), ys = points.map(p => p.y);
      const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
      const rangeX = (maxX - minX) || 1, rangeY = (maxY - minY) || 1, pad = 16;
      const xOf = x => pad + (x - minX) / rangeX * (w - 2 * pad), yOf = y => pad + (y - minY) / rangeY * (h - 2 * pad);
      ctx.strokeStyle = '#0f9488'; ctx.lineWidth = 1.4; ctx.beginPath();
      points.forEach((p, i) => { const x = xOf(p.x), y = yOf(p.y); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
      ctx.stroke();
      ctx.fillStyle = '#178a4c'; ctx.beginPath(); ctx.arc(xOf(xs[0]), yOf(ys[0]), 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#c22a2a'; ctx.beginPath(); ctx.arc(xOf(xs[xs.length - 1]), yOf(ys[ys.length - 1]), 4, 0, Math.PI * 2); ctx.fill();
    }, 0);
    return `<div class="chart-block"><small>Image-plane body-center path (green=start, red=end; not force-plate CoP)</small><canvas id="${id}" width="300" height="240" style="width:100%;max-width:300px;height:240px;background:#fbfbfc;border-radius:10px"></canvas></div>`;
  }

  // ---- Interpreted Results ----
  function regionSection(title, bodyHtml, openByDefault) {
    return `<details class="region-section"${openByDefault ? ' open' : ''}><summary>${escapeHtml(title)}</summary>${bodyHtml}</details>`;
  }

  function renderInterpretedView(container, record) {
    const r = record.interpreted;
    if (!r) { container.innerHTML = '<p>No interpreted data for this trial (interpretation failed or trial predates this feature).</p>'; return; }
    const o = r.whole_body_overview;
    let html = '<div class="movement-summary"><strong>What happened in this trial</strong><ul>';
    for (const side of ['left','right']) {
      const knee=record.camera_posture?.[`${side}_knee`];
      const angle=knee?.peak_frontal_deviation_signed_deg;
      if (Number.isFinite(angle)) html += `<li>${side === 'left' ? 'Left' : 'Right'} knee moved ${Math.abs(angle).toFixed(1)}° ${angle >= 0 ? 'inward (valgus-like)' : 'outward (varus-like)'} at about ${fmt(knee.timestamp_peak_frontal_deviation_seconds,' s')} in the front-camera image. This is a 2D estimate, not a diagnosis.</li>`;
    }
    const contacts=record.events?.filter(e=>e.type==='possible_foot_contact')||[];
    const contactStatus=record.single_leg_metrics?.contact_detection_status;
    if (contactStatus==='estimated') html += `<li>Raised-foot possible floor contacts: ${contacts.length}${contacts.length ? `, near ${contacts.map(e=>fmt(e.timestamp_seconds,' s')).join(', ')}` : ''}. Confirm against the video or an observer; the camera cannot prove contact.</li>`;
    else if (record.single_leg_metrics?.applicable) html += '<li>Raised-foot contact estimate unavailable because the foot was not clearly tracked or lifted.</li>';
    html += '</ul><p class="status-line">Phone acceleration is movement intensity, not distance traveled. For example, 0.3022 m/s² describes how strongly the phone sped up or slowed down on average; it does not mean 0.3022 meters of sway. Compare only like-for-like trials, and review camera tracking quality before interpreting differences.</p></div><details class="region-section"><summary>Detailed measurements and charts</summary>';
    html += `<div class="metric-grid overview-grid">${metricGrid([
      ['Trial', r.trial_name.replace(/_/g, ' ')],
      ['Duration', `${o.duration_seconds}s`],
      ['Tracking quality', `${o.tracking_quality} (${Math.round((o.tracking_quality_fraction ?? 0) * 100)}%)`, o.tracking_quality === 'unreliable'],
      ['Camera body-center path (image normalized)', fmt(o.overall_sway, ' units', 3)],
      ['Max trunk lean', fmt(o.max_trunk_lean, '°')],
      ['Pelvic tilt range', fmt(o.pelvic_tilt_range, '°')],
      ['Left knee ROM', fmt(o.left_knee_rom, '°')],
      ['Right knee ROM', fmt(o.right_knee_rom, '°')],
      ['Ankle repositioning estimates', o.foot_corrections_total],
      ['Asymmetry flagged', o.major_asymmetry_flagged ? 'Yes' : 'No', o.major_asymmetry_flagged],
    ])}</div>`;
    html += `<div class="movement-summary"><strong>Movement summary</strong><ul>${(r.movement_summary || []).filter(s=>!/\b(head|nose|neck|facial)\b/i.test(s)).map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ul></div>`;
    html += `<h4 class="results-group-heading">L5 phone sensor (device coordinates)</h4>`;
    html += metricGrid([
      ['RMS acceleration magnitude', fmt(record.phone_balance?.total_sway, ' m/s²', 3)],
      ['Mean acceleration-change rate (jerk proxy)', fmt(record.phone_balance?.mean_sway_velocity, ' m/s³', 3)],
      ['Acceleration spike events', record.phone_balance?.large_corrections],
    ]) + `<p class="status-line">Source: ${escapeHtml(record.phone_acceleration_source || 'unknown')}. These are phone acceleration measures, not lower-back displacement, body velocity, or force-plate center of pressure. The gravity-including fallback is not comparable with linear acceleration. Device x/y/z axes are not anatomical directions from a quiet-standing reference alone.</p>`;
    const neutral=record.phone_neutral_relative_tilt;
    html += `<h4 class="results-group-heading">Phone tilt relative to neutral standing</h4>`;
    html += neutral?.available ? metricGrid([
      ['Roll RMS from neutral', fmt(neutral.roll_rms_from_neutral_deg, '°', 2)],
      ['Pitch RMS from neutral', fmt(neutral.pitch_rms_from_neutral_deg, '°', 2)],
      ['Orientation samples', neutral.sample_count],
    ]) + '<p class="status-line">These are phone orientation changes from the 5-second quiet-standing reference, not anatomical trunk angles. Raw motion measurements are unchanged.</p>' : `<p class="status-line">Unavailable: ${escapeHtml(neutral?.reason || 'Phone not calibrated for this trial.')}</p>`;

    html += `<h4 class="results-group-heading">iPad sagittal view</h4>`;
    if (record.side_camera) {
      const side = record.side_camera;
      html += metricGrid([
        ['Camera side / measured leg', `${side.camera_side} / ${side.measured_leg}`],
        ['Side-view frames', `${side.frame_count} (${Math.round((side.knee_tracking_fraction ?? 0) * 100)}% knee usable)`],
        ['Average knee bend (2D estimate)', fmt(side.mean_knee_flexion_proxy_deg, '°')],
        ['Most extended (least bend)', fmt(side.min_knee_flexion_proxy_deg, '°')],
        ['Greatest knee bend (2D estimate)', fmt(side.max_knee_flexion_proxy_deg, '°')],
        ['Time of greatest knee bend', fmt(side.peak_knee_flexion_time_seconds, ' s')],
        ['Knee bend range', fmt(side.knee_flexion_range_deg, '°')],
        ['Mean hip flexion proxy', fmt(side.mean_hip_flexion_proxy_deg, '°')],
        ['Mean trunk lean', fmt(side.mean_trunk_lean_deg, '°')],
        ['Horizontal hip excursion', fmt(side.horizontal_hip_excursion_body_heights, ' body heights', 3)],
      ]) + `<p class="status-line">0° means the hip–knee–ankle points appear straight in the side image; 20° means approximately 20° of projected knee bend, not a 160° bend. Keep the iPad fixed and exactly side-on with the measured leg clearly visible. This unsigned angle cannot distinguish hyperextension from flexion. Average, greatest bend and range describe this balance trial, not whether the posture is healthy. ${escapeHtml(side.note)} Facial landmarks are not drawn or transmitted from the iPad.</p>`;
    } else html += '<p>No iPad side-camera recording for this trial.</p>';

    html += `<h4 class="results-group-heading">Computer front view · knee deviation</h4>`;
    html += metricGrid([
      ['Left mean (+ inward / − outward)', fmt(record.camera_posture?.left_knee?.mean_frontal_deviation_deg, '°')],
      ['Left peak magnitude', fmt(record.camera_posture?.left_knee?.peak_frontal_deviation_deg, '°')],
      ['Right mean (+ inward / − outward)', fmt(record.camera_posture?.right_knee?.mean_frontal_deviation_deg, '°')],
      ['Right peak magnitude', fmt(record.camera_posture?.right_knee?.peak_frontal_deviation_deg, '°')],
    ]) + '<p class="status-line">These are 2D projected valgus-like/varus-like deviations, not validated clinical varus/valgus angles. Camera rotation, limb rotation, and occlusion can alter the sign or size.</p>';

    html += `<h4 class="results-group-heading">Balance &amp; Movement</h4>`;
    html += regionSection('Balance & Stability', metricGrid([
      ['Image-plane body-center path', fmt(r.balance_stability.total_sway_path, ' units', 3)],
      ['Image-plane path speed', fmt(r.balance_stability.sway_velocity, ' units/s', 3)],
      ['Max horizontal excursion', fmt(r.balance_stability.max_excursion_ml, ' units', 3)],
      ['Max vertical excursion (not anatomical AP)', fmt(r.balance_stability.max_excursion_ap, ' units', 3)],
      ['Image-plane 95% ellipse area (not CoP ellipse)', fmt(r.balance_stability.sway_area, ' units²', 4)],
    ]) + '<p class="status-line">Camera movement is reported in image-normalized units, not centimeters. Keep camera distance and framing consistent between trials.</p>' + chartCard('Mediolateral sway over time', [{ samples: r.balance_stability.mediolateral_sway.samples, color: '#0f9488' }], 'normalized units')
      + chartCard('Vertical image movement over time (not anatomical AP)', [{ samples: r.balance_stability.anterior_posterior_sway.samples, color: '#f2b134' }], 'normalized units')
      + swayPathCard(r.balance_stability.body_center_path), true);

    html += regionSection('Events Timeline', r.events_timeline.length ? `<ul class="events-list">${r.events_timeline.map(e => `<li><button class="event-jump" data-t="${e.timestamp_seconds}">${e.timestamp_seconds.toFixed(1)}s</button> — ${escapeHtml(e.description)}</li>`).join('')}</ul>` : '<p>No notable events detected in this trial.</p>');

    html += regionSection('Trial-Thirds Trend', `
      <table class="summary-table"><thead><tr><th>Metric</th><th>Early (0–${r.thirds_analysis.windows.early[1].toFixed(1)}s)</th><th>Middle</th><th>Late (${r.thirds_analysis.windows.late[0].toFixed(1)}–${r.thirds_analysis.windows.late[1].toFixed(1)}s)</th></tr></thead><tbody>
      ${Object.entries(r.thirds_analysis.metrics).map(([name, w]) => `<tr><td>${escapeHtml(name.replace(/_/g, ' '))}</td><td>mean ${fmt(w.early.mean, '', 3)}, std ${fmt(w.early.std, '', 3)}</td><td>mean ${fmt(w.middle.mean, '', 3)}, std ${fmt(w.middle.std, '', 3)}</td><td>mean ${fmt(w.late.mean, '', 3)}, std ${fmt(w.late.std, '', 3)}</td></tr>`).join('')}
      </tbody></table>`);

    html += `<h4 class="results-group-heading">Body Regions</h4>`;
    html += regionSection('Shoulders', metricGrid([
      ['Mean tilt', fmt(r.shoulders.mean_tilt, '°')], ['Max left tilt', fmt(r.shoulders.max_left_tilt, '°')], ['Max right tilt', fmt(r.shoulders.max_right_tilt, '°')],
      ['Range', fmt(r.shoulders.range, '°')], ['Variability', fmt(r.shoulders.std, '°')],
    ]) + chartCard('Shoulder tilt over time', [{ samples: r.shoulders.shoulder_tilt.samples }], 'degrees'));

    html += regionSection('Trunk', metricGrid([
      ['Mean lean', fmt(r.trunk.mean_lean, '°')], ['Max deviation', fmt(r.trunk.max_deviation, '°')], ['Direction', r.trunk.dominant_direction],
      ['Range', fmt(r.trunk.range, '°')], ['Variability', fmt(r.trunk.std, '°')], ['Time of max', fmt(r.trunk.timestamp_of_max, 's')],
    ]) + `<p style="font-size:.82rem">${escapeHtml(r.trunk.camera_view_note)}</p>` + chartCard('Trunk lean over time', [{ samples: r.trunk.trunk_lean.samples }], 'degrees'));

    html += regionSection('Pelvis / Hips', metricGrid([
      ['Mean pelvic tilt', fmt(r.pelvis_hips.mean_tilt, '°')], ['Peak left drop', fmt(r.pelvis_hips.peak_left_drop, '°')], ['Peak right drop', fmt(r.pelvis_hips.peak_right_drop, '°')],
      ['Range', fmt(r.pelvis_hips.range, '°')], ['Variability', fmt(r.pelvis_hips.std, '°')],
    ]) + chartCard('Pelvic tilt over time', [{ samples: r.pelvis_hips.pelvic_tilt.samples }], 'degrees')
      + chartCard('Hip-thigh-trunk angle (estimate)', [{ samples: r.pelvis_hips.left_hip_angle.samples, color: '#0f9488' }, { samples: r.pelvis_hips.right_hip_angle.samples, color: '#f2b134' }], 'degrees'));

    function legSection(side, leg) {
      return regionSection(`${side === 'left' ? 'Left' : 'Right'} Leg`, metricGrid([
        ['Mean knee angle', fmt(leg.knee.mean_angle, '°')], ['Knee ROM', fmt(leg.knee.angle_range, '°')],
        ['Peak medial deviation', fmt(leg.knee.peak_medial_deviation, ' units', 3)], ['Peak lateral deviation', fmt(leg.knee.peak_lateral_deviation, ' units', 3)],
        ['Ankle repositioning estimates', leg.ankle.correction_count], ['Tracking confidence', fmt((leg.knee.tracking_confidence ?? 0) * 100, '%', 0)],
      ]));
    }
    html += legSection('left', r.left_leg) + legSection('right', r.right_leg);

    function kneeDetail(side, knee) {
      return `<div class="split-col"><strong>${side === 'left' ? 'Left' : 'Right'} Knee</strong>${metricGrid([
        ['Mean', fmt(knee.mean_angle, '°')], ['Min', fmt(knee.min_angle, '°')], ['Max', fmt(knee.max_angle, '°')], ['Range', fmt(knee.angle_range, '°')],
        ['Peak medial dev.', fmt(knee.peak_medial_deviation, '', 3)], ['Peak lateral dev.', fmt(knee.peak_lateral_deviation, '', 3)],
        ['Time of peak dev.', fmt(knee.timestamp_of_peak_deviation, 's')], ['Variability', fmt(knee.variability, '', 3)],
      ])}${chartCard('Knee angle over time', [{ samples: knee.knee_angle.samples }], 'degrees')}${chartCard('Knee alignment (medial/lateral) over time', [{ samples: knee.knee_alignment.samples }], 'normalized units')}<p style="font-size:.78rem">${escapeHtml(knee.label)}</p></div>`;
    }
    html += regionSection('Knees', `<div class="split-row">${kneeDetail('left', r.left_knee)}${kneeDetail('right', r.right_knee)}</div>`);

    function ankleDetail(side, a) {
      const unavailable = !a.angle_available ? `<p class="warn" style="font-size:.82rem">${escapeHtml(a.unavailable_reason)}</p>` : '';
      return `<div class="split-col"><strong>${side === 'left' ? 'Left' : 'Right'} Ankle/Foot</strong>${metricGrid([['Ankle repositioning estimates', a.correction_count], ['Tracking confidence', fmt((a.tracking_confidence ?? 0) * 100, '%', 0)]])}${unavailable}${a.angle_available ? chartCard('Ankle angle over time', [{ samples: a.ankle_angle.samples }], 'degrees') : ''}</div>`;
    }
    html += regionSection('Ankles / Feet', `<div class="split-row">${ankleDetail('left', r.ankles_feet.left)}${ankleDetail('right', r.ankles_feet.right)}</div>${metricGrid([['Mean stance width', fmt(r.ankles_feet.stance_width.mean, ' units', 3)]])}`);

    html += `<h4 class="results-group-heading">Comparisons &amp; Quality</h4>`;
    html += regionSection('Symmetry', `
      <table class="summary-table"><thead><tr><th>Measurement</th><th>Left</th><th>Right</th><th>Difference</th><th>Symmetry index</th></tr></thead><tbody>
      <tr><td>Min knee angle (flexion)</td><td>${fmt(r.symmetry.knee_flexion.left, '°')}</td><td>${fmt(r.symmetry.knee_flexion.right, '°')}</td><td>${fmt(r.symmetry.knee_flexion.difference, '°')}</td><td>${fmt(r.symmetry.knee_flexion.symmetry_index, '%')}</td></tr>
      <tr><td>Knee range of motion</td><td>${fmt(r.symmetry.knee_rom.left, '°')}</td><td>${fmt(r.symmetry.knee_rom.right, '°')}</td><td>${fmt(r.symmetry.knee_rom.difference, '°')}</td><td>${fmt(r.symmetry.knee_rom.symmetry_index, '%')}</td></tr>
      <tr><td>Ankle repositioning estimates</td><td>${r.symmetry.foot_corrections.left}</td><td>${r.symmetry.foot_corrections.right}</td><td>${r.symmetry.foot_corrections.difference}</td><td>—</td></tr>
      </tbody></table>`);

    html += regionSection('Measurement Quality', metricGrid([
      ['Overall tracking quality', `${Math.round((r.measurement_quality.overall ?? 0) * 100)}% (${r.measurement_quality.tier})`, r.measurement_quality.tier === 'unreliable'],
      ['Frames excluded', `${r.measurement_quality.excludedFrames} / ${r.measurement_quality.totalFrames}`],
      ['Normalization reference', r.normalization.scale_reference],
      ['Camera view', r.camera_orientation],
    ]) + `<table class="summary-table"><thead><tr><th>Region</th><th>Reliable frames</th></tr></thead><tbody>${Object.entries(r.measurement_quality.byRegion).filter(([k])=>k!=='head').map(([k, v]) => `<tr><td>${escapeHtml(k.replace(/_/g, ' '))}</td><td>${Math.round((v ?? 0) * 100)}%</td></tr>`).join('')}</tbody></table>`);

    html += regionSection('Trial Comparison', renderComparisonSection());
    html += regionSection('Progress Over Time', renderProgressSection(r.trial_name, o));

    container.innerHTML = html + '</details>';
    container.querySelectorAll('.event-jump').forEach(btn => btn.onclick = () => seekReplay(+btn.dataset.t));
  }

  function renderComparisonSection() {
    const trials = getAssessment()?.trials || {};
    const average = condition => {
      const values = Object.values(trials).filter(t => (t.condition_id || t.trial_name) === condition).map(t => t.interpreted?.balance_stability?.total_sway_path).filter(Number.isFinite);
      return { count: values.length, value: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null };
    };
    function row(label, openId, closedId) {
      const open = average(openId), closed = average(closedId);
      return `<tr><td>${escapeHtml(label)}</td><td>${fmt(open.value, ' units', 3)} (${open.count}/3)</td><td>${fmt(closed.value, ' units', 3)} (${closed.count}/3)</td><td>${open.value == null || closed.value == null ? '—' : fmt(closed.value - open.value, ' units', 3)}</td></tr>`;
    }
    let html = `<p>Means of completed repetitions. Camera image-plane path is not force-plate CoP displacement.</p><table class="summary-table"><thead><tr><th>Comparison</th><th>Eyes open</th><th>Eyes closed</th><th>Closed − open</th></tr></thead><tbody>${row('Double-leg', 'double_leg_eyes_open', 'double_leg_eyes_closed')}${row('Right single-leg', 'right_leg_eyes_open', 'right_leg_eyes_closed')}${row('Left single-leg', 'left_leg_eyes_open', 'left_leg_eyes_closed')}</tbody></table>`;
    const left = average('left_leg_eyes_open'), right = average('right_leg_eyes_open');
    if (left.value != null && right.value != null) html += `<p style="margin-top:8px">Eyes-open single-leg image-plane path: Left ${fmt(left.value, ' units', 3)}; right ${fmt(right.value, ' units', 3)}.</p>`;
    return html;
  }

  function renderProgressSection(trialName, overview) {
    const history = (() => { try { return JSON.parse(localStorage.getItem('assessment-history') || '[]'); } catch { return []; } })();
    const priorOverviews = history.map(h => h.assessment?.trials?.find(t => t.trial_name === trialName)?.interpreted?.whole_body_overview).filter(Boolean);
    if (!priorOverviews.length) return '<p>No previous sessions with this trial yet. Progress comparisons will appear here once you complete more than one full assessment.</p>';
    const baseline = priorOverviews[0], previous = priorOverviews[priorOverviews.length - 1];
    const vsBaseline = Interpretation.compareToBaseline(overview, baseline);
    const vsPrevious = Interpretation.compareToBaseline(overview, previous);
    function line(cmp, label) { if (!cmp) return ''; return `<li>Overall sway change ${escapeHtml(label)}: ${fmt(cmp.overall_sway_change, ' units', 3)}. Max trunk lean change: ${fmt(cmp.max_trunk_lean_change, '°')}. Pelvic tilt range change: ${fmt(cmp.pelvic_tilt_range_change, '°')}. Foot corrections change: ${cmp.foot_corrections_change ?? '—'}.</li>`; }
    return `<ul>${line(vsBaseline, 'vs. baseline (first recorded session)')}${line(vsPrevious, 'vs. previous session')}</ul><p style="font-size:.8rem">Changes are reported as measured differences only; whether a change represents improvement depends on the specific metric and is for the clinician to judge.</p>`;
  }

  // ---- Raw Results ----
  async function renderRawView(container, record) {
    const generation = ++rawViewGeneration;
    container.innerHTML = '<p>Loading raw data…</p>';
    const raw = await RawStore.loadRawTrial(record.trial_id).catch(() => null);
    if (generation !== rawViewGeneration) return;
    if (!raw || !raw.cameraFrames?.length) { container.innerHTML = '<p>No raw data stored for this trial (it may predate this feature, or storage may be unavailable in this browser).</p>'; return; }
    rawCache = raw;
    const frames = raw.cameraFrames;
    const landmarkNames = Object.keys(frames[0].landmarks).filter(name=>!FACE_POINTS.has(name));

    let html = `
      <div class="button-row secondary-row" style="margin-bottom:6px">
        <button id="raw-export-csv" class="outline">Export CSV</button>
        <button id="raw-export-json" class="outline">Export JSON</button>
        ${raw.sideFrames?.length ? '<button id="raw-export-side-csv" class="outline">Export iPad side CSV</button>' : ''}
      </div>
      <div class="replay-panel">
        <div class="stage replay-stage" id="replay-stage"><canvas id="replay-canvas" width="480" height="540" style="width:100%;height:100%"></canvas></div>
        <div class="replay-controls">
          <button id="replay-back" class="outline">⏮</button>
          <button id="replay-play" class="outline">▶ Play</button>
          <button id="replay-fwd" class="outline">⏭</button>
          <input id="replay-scrub" type="range" min="0" max="${frames.length - 1}" value="0" style="flex:1">
          <select id="replay-speed"><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option></select>
          <span id="replay-time">0.00s / frame 0</span>
        </div>
      </div>
      <div class="raw-filters">
        <label>Body point <select id="raw-filter-point"><option value="">All</option>${landmarkNames.map(n => `<option value="${n}">${n.replace(/_/g, ' ')}</option>`).join('')}</select></label>
        <label>Axis <select id="raw-filter-axis"><option value="">X/Y/Z/Confidence</option><option value="x">X only</option><option value="y">Y only</option><option value="z">Z only</option><option value="confidence">Confidence only</option></select></label>
        <label>Min confidence <input id="raw-filter-confidence" type="number" min="0" max="1" step="0.05" value="0"></label>
        <label>Chart point <select id="raw-chart-point">${landmarkNames.map(n => `<option value="${n}"${n === 'left_knee' ? ' selected' : ''}>${n.replace(/_/g, ' ')}</option>`).join('')}</select></label>
      </div>
      <div id="raw-chart-holder"></div>
      <div class="table-wrap"><table class="summary-table raw-table" id="raw-table"><thead></thead><tbody></tbody></table></div>
      <p style="font-size:.78rem">Raw coordinates are normalized image coordinates 0–1, not spatially calibrated. Front frames: ${frames.length}. iPad side frames: ${raw.sideFrames?.length || 0}. Phone samples: ${raw.phoneSamples?.length || 0}. The front and side streams remain separate.</p>
    `;
    container.innerHTML = html;

    function renderTable() {
      const point = $('raw-filter-point').value, axis = $('raw-filter-axis').value, minConf = parseFloat($('raw-filter-confidence').value) || 0;
      const points = point ? [point] : landmarkNames;
      const axes = axis ? [axis] : ['x', 'y', 'z', 'confidence'];
      const thead = $('raw-table').querySelector('thead'), tbody = $('raw-table').querySelector('tbody');
      let cols = ['Frame', 'Time (s)'];
      for (const p of points) for (const ax of axes) cols.push(`${p.replace(/_/g, ' ')} ${ax}`);
      thead.innerHTML = `<tr>${cols.map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr>`;
      const rows = frames.map((f, i) => {
        let show = true;
        if (minConf > 0) show = points.some(p => (f.landmarks[p]?.confidence ?? 0) >= minConf);
        if (!show) return null;
        let cells = [i, f.timestamp_seconds.toFixed(3)];
        for (const p of points) for (const ax of axes) { const v = f.landmarks[p]?.[ax]; cells.push(v == null ? '—' : (typeof v === 'number' ? v.toFixed(4) : v)); }
        return `<tr>${cells.map(c => `<td>${escapeHtml(String(c))}</td>`).join('')}</tr>`;
      }).filter(Boolean);
      tbody.innerHTML = rows.slice(0, 500).join('') + (rows.length > 500 ? `<tr><td colspan="${cols.length}">…and ${rows.length - 500} more frames (showing first 500; export CSV for the full set).</td></tr>` : '');
    }
    function renderRawChart() {
      const point = $('raw-chart-point').value;
      const series = ['x', 'y', 'z', 'confidence'].map((ax, i) => ({ samples: frames.map(f => ({ t: f.timestamp_seconds, value: f.landmarks[point]?.[ax] ?? null })), color: ['#0f9488', '#f2b134', '#707c8c', '#c22a2a'][i] }));
      $('raw-chart-holder').innerHTML = chartCard(`${point.replace(/_/g, ' ')}: X (teal), Y (yellow), Z (gray), Confidence (pink)`, series, '');
    }
    $('raw-filter-point').onchange = renderTable; $('raw-filter-axis').onchange = renderTable; $('raw-filter-confidence').oninput = renderTable;
    $('raw-chart-point').onchange = renderRawChart;
    renderTable(); renderRawChart();

    $('raw-export-json').onclick = () => downloadFile(`${record.trial_name}-raw.json`, JSON.stringify(withoutHeadData(raw), null, 2), 'application/json');
    if ($('raw-export-side-csv')) $('raw-export-side-csv').onclick = () => {
      const sideFrames = raw.sideFrames || [];
      const names = Object.keys(sideFrames[0]?.landmarks || {});
      const header = ['frame', 'time_s', 'image_width', 'image_height', ...names.flatMap(name => [`${name}_x`, `${name}_y`, `${name}_confidence`])];
      const rows = sideFrames.map((frame, i) => [i, frame.timestamp_seconds, frame.image_width, frame.image_height, ...names.flatMap(name => { const point = frame.landmarks[name] || {}; return [point.x ?? '', point.y ?? '', point.confidence ?? '']; })].join(','));
      downloadFile(`${record.trial_name}-ipad-side.csv`, [header.join(','), ...rows].join('\n'), 'text/csv');
    };
    $('raw-export-csv').onclick = () => {
      const header = ['frame', 'time_s', ...landmarkNames.flatMap(n => [`${n}_x`, `${n}_y`, `${n}_z`, `${n}_confidence`])];
      const rows = frames.map((f, i) => [i, f.timestamp_seconds, ...landmarkNames.flatMap(n => { const p = f.landmarks[n] || {}; return [p.x, p.y, p.z, p.confidence]; })].join(','));
      downloadFile(`${record.trial_name}-raw.csv`, [header.join(','), ...rows].join('\n'), 'text/csv');
    };

    setupReplay(frames);
  }

  function downloadFile(name, content, type) {
    const blob = new Blob([content], { type }), url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---- Skeleton replay ----

  function setupReplay(frames) {
    if (replayState) clearTimeout(replayState.timer);
    replayState = { frames, index: 0, playing: false, speed: 1, timer: null };
    drawReplayFrame(0);
    $('replay-scrub').oninput = () => { replayPause(); replayState.index = +$('replay-scrub').value; drawReplayFrame(replayState.index); };
    $('replay-play').onclick = () => replayState.playing ? replayPause() : replayPlay();
    $('replay-back').onclick = () => { replayPause(); replayState.index = Math.max(0, replayState.index - 1); drawReplayFrame(replayState.index); };
    $('replay-fwd').onclick = () => { replayPause(); replayState.index = Math.min(frames.length - 1, replayState.index + 1); drawReplayFrame(replayState.index); };
    $('replay-speed').onchange = () => { replayState.speed = +$('replay-speed').value; };
  }
  function replayPlay() {
    replayState.playing = true; $('replay-play').textContent = '⏸ Pause';
    const step = () => {
      if (!replayState.playing) return;
      replayState.index++;
      if (replayState.index >= replayState.frames.length) { replayPause(); return; }
      drawReplayFrame(replayState.index);
      const dt = Math.max(16, 33 / replayState.speed);
      replayState.timer = setTimeout(step, dt);
    };
    step();
  }
  function replayPause() { replayState.playing = false; clearTimeout(replayState.timer); const btn = $('replay-play'); if (btn) btn.textContent = '▶ Play'; }
  function drawReplayFrame(index) {
    const frame = replayState.frames[index]; if (!frame) return;
    $('replay-scrub').value = index;
    $('replay-time').textContent = `${frame.timestamp_seconds.toFixed(2)}s / frame ${index}`;
    const canvas = $('replay-canvas'); if (!canvas) return;
    const ctx = canvas.getContext('2d'); const w = canvas.width, h = canvas.height;
    SideView.drawStick(ctx, frame.landmarks, w, h, 'left');
  }
  function seekReplay(t) {
    if (!replayState) return;
    replayPause();
    let best = 0, bestDiff = Infinity;
    replayState.frames.forEach((f, i) => { const diff = Math.abs(f.timestamp_seconds - t); if (diff < bestDiff) { bestDiff = diff; best = i; } });
    replayState.index = best; drawReplayFrame(best);
    $('replay-canvas')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // ---- Public entry points ----
  function populateTrialSelect(selectEl, assessment) {
    const done = Assessment.TRIALS.filter(t => assessment.trials[t.trial_name]?.status === 'completed' && assessment.trials[t.trial_name]?.protocol_valid !== false && assessment.trials[t.trial_name]?.duration_seconds === Assessment.TRIAL_DURATION_SECONDS);
    selectEl.innerHTML = done.map(t => `<option value="${t.trial_name}">${escapeHtml(t.label)}</option>`).join('') || '<option value="">No completed trials yet</option>';
    if (done.length && !done.some(t => t.trial_name === currentTrialName)) currentTrialName = done[0].trial_name;
    if (currentTrialName) selectEl.value = currentTrialName;
  }

  global.ResultsUI = {
    init(deps) { $ = deps.$; escapeHtml = deps.escapeHtml; if (deps.getAssessment) getAssessment = deps.getAssessment; },
    populateTrialSelect,
    setCurrentTrial(name) { currentTrialName = name; },
    getCurrentTrial() { return currentTrialName; },
    renderInterpretedView, renderRawView, withoutHeadData,
  };
})(typeof window !== 'undefined' ? window : globalThis);
