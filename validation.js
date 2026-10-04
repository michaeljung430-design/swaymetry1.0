// Local-only laboratory comparison helpers. No reference file is uploaded.
(function (global) {
  const finite = value => Number.isFinite(value) ? value : null;
  const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;

  function parseViconCsv(text) {
    if (typeof text !== 'string' || text.length > 40_000_000) throw new Error('Choose a CSV smaller than 40 MB.');
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
    const start = lines.findIndex(line => line.trim() === 'Model Outputs');
    if (start < 0) throw new Error('This CSV has no Vicon Model Outputs section. Export Model Outputs from the laboratory software.');
    const rate = Number(lines[start + 1]);
    if (!(rate > 0 && rate <= 2000)) throw new Error('Model Outputs sample rate is missing or invalid.');
    const names = lines[start + 2].split(',');
    const axes = lines[start + 3].split(',');
    const units = lines[start + 4].split(',');
    const columns = {};
    let current = '';
    for (let i = 2; i < axes.length; i++) {
      if (names[i]) current = names[i].trim();
      if (current && axes[i]) columns[`${current}.${axes[i].trim()}`] = { index: i, unit: units[i]?.trim() || '' };
    }
    const wanted = ['CentreOfMass.X', 'CentreOfMass.Y', 'CentreOfMass.Z', 'RKneeAngles.X', 'LKneeAngles.X', 'RHipAngles.X', 'LHipAngles.X', 'RPelvisAngles.Y', 'RThoraxAngles.Y'];
    const matched = {};
    for (const suffix of wanted) {
      const key = Object.keys(columns).find(name => name.endsWith(`:${suffix}`));
      if (key) matched[suffix] = { ...columns[key], values: [] };
    }
    if (!Object.keys(matched).length) throw new Error('No supported model-output columns were found in this CSV.');
    const times = [];
    for (let i = start + 5; i < lines.length; i++) {
      const line = lines[i];
      if (!line || line === 'Trajectories' || line === 'Devices') break;
      const cells = line.split(',');
      const frame = Number(cells[0]);
      if (!Number.isFinite(frame)) continue;
      times.push((frame - 1) / rate);
      for (const column of Object.values(matched)) {
        const raw = cells[column.index];
        column.values.push(raw == null || raw.trim() === '' ? null : finite(Number(raw)));
      }
    }
    if (times.length < 10) throw new Error('Too few Model Outputs samples for a trial comparison.');
    return { rate_hz: rate, duration_seconds: times[times.length - 1], times, columns: matched };
  }

  function compareSeries(appSamples, reference, offsetSeconds = 0) {
    const offset = Number(offsetSeconds);
    if (!Number.isFinite(offset) || Math.abs(offset) > 10) throw new Error('Sync offset must be between -10 and 10 seconds.');
    const a = appSamples.filter(point => Number.isFinite(point.t) && Number.isFinite(point.value));
    const b = reference.times;
    if (a.length < 10 || b.length < 10) throw new Error('Both series need at least 10 valid samples.');
    const differences = [];
    let j = 0;
    for (const point of a) {
      const target = point.t + offset;
      while (j + 1 < b.length && b[j + 1] < target) j++;
      if (target < b[0] || j + 1 >= b.length) continue;
      const left = reference.values[j], right = reference.values[j + 1];
      if (!Number.isFinite(left) || !Number.isFinite(right) || b[j + 1] === b[j]) continue;
      const interpolated = left + (right - left) * (target - b[j]) / (b[j + 1] - b[j]);
      differences.push(point.value - interpolated);
    }
    if (differences.length < 10) throw new Error('Too little overlapping data. Check the chosen trial and sync offset.');
    const bias = mean(differences);
    const sd = Math.sqrt(differences.reduce((sum, value) => sum + (value - bias) ** 2, 0) / (differences.length - 1));
    return {
      matched_samples: differences.length,
      bias: bias,
      mae: mean(differences.map(Math.abs)),
      rmse: Math.sqrt(mean(differences.map(value => value ** 2))),
      descriptive_difference_band: [bias - 1.96 * sd, bias + 1.96 * sd],
    };
  }
  global.Validation = { parseViconCsv, compareSeries };
})(typeof window !== 'undefined' ? window : globalThis);
if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.Validation;
