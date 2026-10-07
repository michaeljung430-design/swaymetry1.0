// Descriptive reports only. Quality rules are engineering checks, not clinical cutoffs.
(function (global) {
  const VERSION = 'image-plane-v2';
  const metrics = [
    { key: 'rms', label: 'Phone acceleration intensity (RMS)', unit: 'm/s²', sensor: 'phone', get: t => t.phone_balance?.total_sway },
    { key: 'jerk', label: 'Phone acceleration changes (jerk proxy)', unit: 'm/s³', sensor: 'phone', get: t => t.phone_balance?.mean_sway_velocity },
    { key: 'trunk', label: 'Front-view trunk lean', unit: '°', sensor: 'camera', get: t => t.camera_posture?.trunk?.mean_lean },
    { key: 'pelvis', label: 'Front-view pelvic tilt', unit: '°', sensor: 'camera', get: t => t.camera_posture?.pelvis?.mean_tilt },
    { key: 'leftKnee', label: 'Left knee projected alignment (+ inward, − outward)', unit: '°', sensor: 'camera', get: t => t.camera_posture?.left_knee?.mean_frontal_deviation_deg },
    { key: 'rightKnee', label: 'Right knee projected alignment (+ inward, − outward)', unit: '°', sensor: 'camera', get: t => t.camera_posture?.right_knee?.mean_frontal_deviation_deg },
    { key: 'sideKnee', label: 'Side-view knee flexion estimate', unit: '°', sensor: 'side', get: t => t.side_camera?.mean_knee_flexion_proxy_deg },
    { key: 'contacts', label: 'Possible raised-foot contacts (confirm visually)', unit: 'events', sensor: 'camera', get: t => t.single_leg_metrics?.opposite_foot_touchdowns },
  ];
  const finite = Number.isFinite;
  const escape = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n, unit = '') => finite(n) ? `${n.toFixed(2)} ${unit}`.trim() : 'Unavailable';
  const trialsOf = assessment => (Array.isArray(assessment?.trials) ? assessment.trials : Object.values(assessment?.trials || {})).filter(Boolean);
  function coverage(samples, duration) {
    const times = (samples || []).map(s => s.timestamp_seconds).filter(finite).sort((a,b) => a-b);
    if (times.length < 2 || !finite(duration) || duration <= 0) return { sufficient: false, max_gap_seconds: null };
    const gaps = [times[0], ...times.slice(1).map((t,i) => t-times[i]), Math.max(0,duration-times.at(-1))];
    return { sufficient: times[0] <= 1 && times.at(-1) >= duration * 0.9, max_gap_seconds: Math.max(...gaps), sample_count: times.length };
  }
  function quality(trial, sensor) {
    if (trial.status !== 'completed' || trial.protocol_valid === false) return 'Trial incomplete or protocol error';
    if (sensor === 'side') return trial.protocol_context?.side_capture_complete ? null : 'Side recording missing or incomplete';
    const q = trial.data_quality?.[`${sensor}_tracking_quality`];
    if (!finite(q) || q < 0.8) return `${sensor === 'camera' ? 'Front camera' : 'Phone'} tracking below 80% usable readings`;
    const coverage = trial.capture_coverage?.[sensor];
    if (coverage && (!coverage.sufficient || coverage.max_gap_seconds > 0.5)) return 'Recording coverage incomplete or gaps over 0.5 seconds';
    if (!coverage) return 'Legacy recording: timing coverage not verified';
    if (sensor === 'camera' && trial.measurement_version !== VERSION) return 'Legacy angle calculation: re-record for comparison';
    if (sensor === 'phone' && trial.phone_acceleration_source !== 'linear_acceleration') return 'Gravity-free acceleration unavailable or source unknown';
    return null;
  }
  function stats(values) {
    if (!values.length) return { n: 0, mean: null, sd: null };
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return { n: values.length, mean, sd: values.length > 1 ? Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1)) : null };
  }
  function summarize(assessment) {
    const trials = trialsOf(assessment), groups = {};
    for (const t of trials) {
      const id = t.condition_id || t.trial_name?.replace(/_rep_\d+$/, '');
      if (!id) continue;
      (groups[id] ||= []).push(t);
    }
    return Object.entries(groups).map(([condition, runs]) => ({ condition, runs, values: Object.fromEntries(metrics.map(m => [m.key, stats(runs.filter(t => !quality(t, m.sensor)).map(m.get).filter(finite))])) }));
  }
  function participant(assessment) {
    return assessment?.participant_code || assessment?.assessment?.patient_id || trialsOf(assessment).find(t => t.protocol_context?.participant_code)?.protocol_context.participant_code || null;
  }
  function compare(current, previous) {
    const code = participant(current);
    if (!code || code !== participant(previous)) return { reason: 'Select a visit with the same participant code.', rows: [] };
    const currentTrials = trialsOf(current), previousTrials = trialsOf(previous);
    if (!currentTrials.length || !previousTrials.length) return { reason: 'Both visits need recorded trials.', rows: [] };
    const signature = ts => [...new Set(ts.map(t => `${t.duration_seconds}:${t.protocol_context?.phone_placement || 'unknown'}:${t.protocol_context?.camera_view || 'unknown'}`))].sort().join('|');
    if (signature(currentTrials) !== signature(previousTrials)) return { reason: 'Duration, camera view or phone placement differs. Repeat the same setup before comparing.', rows: [] };
    const prior = new Map(summarize(previous).map(g => [g.condition, g]));
    const rows = [];
    for (const group of summarize(current)) {
      const old = prior.get(group.condition);
      if (!old) continue;
      for (const m of metrics) {
        const a = old.values[m.key], b = group.values[m.key];
        if (!a.n || !b.n) continue;
        rows.push({ condition: group.condition, metric: m.label, unit: m.unit, previous: a.mean, current: b.mean, change: b.mean - a.mean, previousN: a.n, currentN: b.n });
      }
    }
    return { reason: rows.length ? null : 'No matching measurements passed the recording checks in both visits.', rows };
  }
  function evidence(assessment) {
    const lines = [];
    for (const trial of trialsOf(assessment)) {
      if (quality(trial, 'camera')) continue;
      const label = (trial.trial_name || 'Trial').replace(/_/g, ' ');
      for (const side of ['left', 'right']) {
        const knee = trial.camera_posture?.[`${side}_knee`];
        const value = knee?.peak_frontal_deviation_signed_deg, time = knee?.timestamp_peak_frontal_deviation_seconds;
        if (finite(value) && finite(time)) lines.push(`${label}: ${side} knee projected ${fmt(Math.abs(value), '°')} ${value > 0 ? 'inward' : value < 0 ? 'outward' : 'from straight alignment'} at ${fmt(time, 's')}.`);
      }
      for (const e of trial.events || []) if (e.type === 'possible_foot_contact' && finite(e.timestamp_seconds)) lines.push(`${label}: possible raised-foot contact at ${fmt(e.timestamp_seconds, 's')}; confirm in the recording or observer notes.`);
    }
    return lines;
  }
  function render(assessment, host) {
    const groups = summarize(assessment), trials = trialsOf(assessment);
    const rows = groups.flatMap(g => metrics.map(m => {
      const s = g.values[m.key];
      return `<tr><td>${escape(g.condition.replace(/_/g, ' '))}</td><td>${escape(m.label)}</td><td>${s.n ? escape(fmt(s.mean, m.unit)) : 'Unavailable'}</td><td>${escape(fmt(s.sd, m.unit))}</td><td>${s.n}/${g.runs.length}</td></tr>`;
    })).join('');
    const issues = trials.flatMap(t => ['camera', 'phone', ...(t.protocol_context?.side_camera_requested ? ['side'] : [])].map(sensor => {
      const reason = quality(t, sensor);
      return reason ? `${(t.trial_name || 'Trial').replace(/_/g, ' ')} — ${reason}.` : null;
    }).filter(Boolean));
    host.innerHTML = `<h2>Session report</h2><p>Participant: ${escape(participant(assessment) || 'Not entered')} · ${escape(assessment.date || assessment.assessment?.date || '')}</p><p>${trials.filter(t => t.status === 'completed').length} recorded runs. Values below use only recordings passing the engineering checks. They are not clinical pass/fail scores.</p><div class="table-wrap"><table class="summary-table"><thead><tr><th>Condition</th><th>Measurement</th><th>Mean</th><th>Run-to-run SD</th><th>Usable runs</th></tr></thead><tbody>${rows || '<tr><td colspan="5">Record a trial to begin.</td></tr>'}</tbody></table></div><details><summary>Specific observations and recording checks</summary><ul>${[...evidence(assessment), ...issues].map(s => `<li>${escape(s)}</li>`).join('') || '<li>No timestamped observations available.</li>'}</ul></details><p>RMS describes acceleration intensity, not distance. Jerk describes changes in acceleration, not velocity. Camera degrees are 2D projections. A smaller number is not automatically healthier. SD describes differences between runs; it is not measurement accuracy.</p><label for="clinic-note">Therapist / observer note (editable, not AI-generated)</label><textarea id="clinic-note" rows="3" placeholder="Record observed contacts, setup differences, symptoms and your interpretation."></textarea><div class="button-row"><button type="button" id="clinic-print">Print / save report as PDF</button><button type="button" class="outline" id="clinic-copy">Copy report for notes</button></div><p id="clinic-feedback" role="status"></p><label for="clinic-previous">Compare with a saved visit for this participant</label><select id="clinic-previous"><option value="">Choose a saved visit</option></select><div id="clinic-progress"></div><p>Between-visit changes are descriptive. Whether they exceed measurement error or represent meaningful improvement has not been established. Use the same mounting, framing, footwear and protocol each time.</p>`;
    host.querySelector('#clinic-note').value = assessment.clinician_note || '';
    host.querySelector('#clinic-copy').onclick = async () => {
      try { await navigator.clipboard.writeText(host.innerText + '\nObserver note: ' + host.querySelector('#clinic-note').value); host.querySelector('#clinic-feedback').textContent = 'Report copied.'; }
      catch { host.querySelector('#clinic-feedback').textContent = 'Copy unavailable. Select the report text or print it instead.'; }
    };
    host.querySelector('#clinic-print').onclick = () => window.print();
    return host;
  }
  global.ClinicReport = { VERSION, metrics, coverage, quality, stats, summarize, participant, compare, evidence, render };
  if (typeof module !== 'undefined') module.exports = global.ClinicReport;
})(typeof window !== 'undefined' ? window : globalThis);
