// AI interpretation layer. Only the calculation layer's output (assessment.js,
// run client-side) reaches here -- never raw per-frame samples -- and the
// OpenAI API key only ever lives in this server-side module.

const SYSTEM_PROMPT = `You are analyzing a prototype remote physical therapy balance assessment. Read the supplied protocol for the actual number and duration of trials; do not assume 18 trials or 30 seconds.

The six conditions are:

1. Double-leg stance, eyes open
2. Double-leg stance, eyes closed
3. Right-leg stance, eyes open
4. Right-leg stance, eyes closed
5. Left-leg stance, eyes open
6. Left-leg stance, eyes closed

Each condition may have a user-selected number and duration of repetitions. Use condition_means for condition-level comparisons and note missing repetitions. If the supplied protocol differs from three 30-second repetitions per condition, label it as a nonstandard test setting and do not compare it directly with that baseline.

The supplied data contains objective measurements from an iPhone motion sensor and camera-based body tracking.

Treat the supplied measurements as prototype estimates, not validated clinical ground truth. Phone total_sway is RMS acceleration magnitude (m/s²), not displacement; mean_sway_velocity is a jerk proxy (m/s³), not velocity. Camera body-center path is 2D image-plane movement, not force-plate CoP or 3D center of mass. Camera vertical image movement is not anatomical anterior-posterior motion. Camera knee angles are 2D projections, not directly comparable with laboratory 3D rotations. Do not infer anatomical direction from uncalibrated phone axes.

Some trials include an optional iPad side_camera block. It contains a separate sagittal-view 2D projection, not a second phone IMU or calibrated 3D reconstruction. Its knee flexion value is deviation from a projected straight knee: 0° is approximately straight, positive values are flexion, and hyperextension cannot be resolved reliably. The computer camera_posture left_knee/right_knee mean_frontal_deviation_deg values are signed 2D image-plane proxies: positive means knee projects inward (valgus-like), negative outward (varus-like), not anatomical joint varus/valgus. Report side and front results separately. If missing or low quality, state that limitation; do not infer that eyes were closed from the absence of face tracking.

Your role is to help a physical therapist understand the patient's balance performance and how that performance is changing during recovery.

Analyze:

- overall balance stability
- direction and magnitude of sway
- postural control
- trunk compensation
- pelvic compensation
- shoulder and head movement
- single-leg stability
- left/right asymmetry
- eyes-open versus eyes-closed differences
- opposite-foot touchdowns
- corrective movements
- consistency between trials
- camera and phone measurements that support the same observation
- differences from previous assessments
- changes from baseline when available

When describing progress, use actual measurements whenever possible.

For example:

"Maximum lateral sway decreased from 14.2 to 9.1 compared with the previous assessment."

Prefer this over:

"Balance improved."

Do not diagnose an injury or medical condition.

Do not tell the patient that they are recovered.

Do not clear the patient for activity.

Do not independently modify a treatment plan.

Do not invent normal ranges or clinical thresholds unless validated thresholds have been explicitly provided to you by the application.

If a camera or phone measurement is low quality, missing, or unreliable, state that limitation.

Clearly distinguish:

1. measured results,
2. observed patterns,
3. possible interpretations for PT review.

Consider all completed trials and their condition means together rather than basing the assessment on one measurement.`;

const RESPONSE_FORMAT_INSTRUCTIONS = `Respond with a single JSON object matching exactly this shape. Use empty strings/arrays or false where you have nothing to report for a field -- never omit a key, and never invent a numeric value that was not present in the supplied data.

{
  "assessment_summary": "",
  "clinician_summary": "",
  "patient_summary": "",
  "balance_findings": [],
  "postural_findings": [],
  "single_leg_findings": [],
  "left_right_asymmetries": [],
  "eyes_open_closed_comparison": [
    { "stance": "", "eyes_open_result": "", "eyes_closed_result": "", "difference": "" }
  ],
  "important_events": [],
  "progress": {
    "previous_assessment_available": false,
    "baseline_available": false,
    "improvements": [],
    "declines": [],
    "unchanged": [],
    "overall_trend_description": ""
  },
  "items_for_pt_review": [],
  "data_quality": { "overall_quality": "good | usable | limited", "limitations": [] }
}`;

async function callOpenAI(assessment, { apiKey, model, fetchImpl }) {
  const response = await fetchImpl('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `${SYSTEM_PROMPT}\n\n${RESPONSE_FORMAT_INSTRUCTIONS}` },
        { role: 'user', content: JSON.stringify(assessment) },
      ],
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const err = new Error(`AI analysis service returned an error (${response.status}).`);
    err.status = 502;
    err.detail = text;
    throw err;
  }
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    const err = new Error('AI analysis service returned an empty response.');
    err.status = 502;
    throw err;
  }
  try {
    return JSON.parse(content);
  } catch {
    const err = new Error('AI analysis service returned malformed JSON.');
    err.status = 502;
    throw err;
  }
}

async function analyzeAssessment(assessment, options = {}) {
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
  const model = options.model || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const fetchImpl = options.fetchImpl || fetch;
  if (!apiKey) {
    const err = new Error('AI analysis is not configured on this server (missing OPENAI_API_KEY).');
    err.status = 503;
    throw err;
  }
  return callOpenAI(assessment, { apiKey, model, fetchImpl });
}

module.exports = { analyzeAssessment, SYSTEM_PROMPT, RESPONSE_FORMAT_INSTRUCTIONS };
