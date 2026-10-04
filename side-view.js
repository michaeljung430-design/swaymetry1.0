// Body-only stick drawing and descriptive side-view metrics. No face mesh,
// video frames, or real-world distance calibration are used here.
(function (global) {
  const names = [
    'nose', 'left_eye_inner', 'left_eye', 'left_eye_outer', 'right_eye_inner', 'right_eye', 'right_eye_outer',
    'left_ear', 'right_ear', 'mouth_left', 'mouth_right', 'left_shoulder', 'right_shoulder',
    'left_elbow', 'right_elbow', 'left_wrist', 'right_wrist', 'left_pinky', 'right_pinky',
    'left_index', 'right_index', 'left_thumb', 'right_thumb', 'left_hip', 'right_hip',
    'left_knee', 'right_knee', 'left_ankle', 'right_ankle', 'left_heel', 'right_heel',
    'left_foot_index', 'right_foot_index',
  ];
  const idx = Object.fromEntries(names.map((name, index) => [name, index]));
  const visible = point => point && Number.isFinite(point.x) && Number.isFinite(point.y) && (point.visibility ?? point.confidence ?? 0) >= 0.45;
  const pointFrom = (landmarks, name) => Array.isArray(landmarks) ? landmarks[idx[name]] : landmarks?.[name];
  const pixel = (frame, name) => {
    const point = pointFrom(frame.landmarks, name);
    return visible(point) ? { x: point.x * frame.image_width, y: point.y * frame.image_height } : null;
  };
  const midpoint = (a, b) => a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null;
  const angle = (a, b, c) => {
    if (!a || !b || !c) return null;
    const u = { x: a.x - b.x, y: a.y - b.y }, v = { x: c.x - b.x, y: c.y - b.y };
    const length = Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y);
    return length ? Math.acos(Math.max(-1, Math.min(1, (u.x * v.x + u.y * v.y) / length))) * 180 / Math.PI : null;
  };
  const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const rounded = value => Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
  function analyze(frames, trial, cameraSide = 'left') {
    const side = trial?.stance === 'single_leg' ? trial.tested_leg : cameraSide;
    const observations = frames.map(frame => {
      if (!Number.isFinite(frame.image_width) || !Number.isFinite(frame.image_height)) return null;
      const sh = midpoint(pixel(frame, 'left_shoulder'), pixel(frame, 'right_shoulder'));
      const hip = midpoint(pixel(frame, 'left_hip'), pixel(frame, 'right_hip'));
      const nearShoulder = pixel(frame, `${side}_shoulder`);
      const nearHip = pixel(frame, `${side}_hip`);
      const knee = pixel(frame, `${side}_knee`);
      const ankle = pixel(frame, `${side}_ankle`);
      const foot = pixel(frame, `${side}_foot_index`);
      const trunk = sh && hip ? Math.atan2(Math.abs(sh.x - hip.x), Math.abs(sh.y - hip.y)) * 180 / Math.PI : null;
      const kneeFlexion = angle(nearHip, knee, ankle);
      const hipFlexion = angle(nearShoulder, nearHip, knee);
      const ankleAngle = angle(knee, ankle, foot);
      const height = sh && ankle ? Math.hypot(sh.x - ankle.x, sh.y - ankle.y) : null;
      return {
        timestamp_seconds: frame.timestamp_seconds,
        trunk_lean_deg: trunk,
        knee_flexion_proxy_deg: kneeFlexion == null ? null : 180 - kneeFlexion,
        hip_flexion_proxy_deg: hipFlexion == null ? null : 180 - hipFlexion,
        ankle_interior_angle_deg: ankleAngle,
        hip_x: hip?.x ?? null,
        body_height_px: height,
      };
    }).filter(Boolean);
    const values = key => observations.map(row => row[key]).filter(Number.isFinite);
    const knee = values('knee_flexion_proxy_deg');
    const hip = values('hip_flexion_proxy_deg');
    const trunk = values('trunk_lean_deg');
    const ankle = values('ankle_interior_angle_deg');
    const hipX = values('hip_x');
    const heights = values('body_height_px');
    return {
      camera_side: cameraSide,
      measured_leg: side,
      frame_count: frames.length,
      covered_seconds: new Set(frames.map(frame => Math.floor(frame.timestamp_seconds)).filter(Number.isFinite)).size,
      first_frame_seconds: frames.length ? rounded(frames[0].timestamp_seconds) : null,
      last_frame_seconds: frames.length ? rounded(frames[frames.length - 1].timestamp_seconds) : null,
      usable_knee_frames: knee.length,
      knee_tracking_fraction: frames.length ? rounded(knee.length / frames.length) : 0,
      mean_knee_flexion_proxy_deg: rounded(mean(knee)),
      max_knee_flexion_proxy_deg: knee.length ? rounded(Math.max(...knee)) : null,
      knee_flexion_series: observations.filter(row => Number.isFinite(row.timestamp_seconds) && Number.isFinite(row.knee_flexion_proxy_deg)).map(row => ({ t:rounded(row.timestamp_seconds), value:rounded(row.knee_flexion_proxy_deg) })),
      mean_hip_flexion_proxy_deg: rounded(mean(hip)),
      max_hip_flexion_proxy_deg: hip.length ? rounded(Math.max(...hip)) : null,
      mean_trunk_lean_deg: rounded(mean(trunk)),
      max_trunk_lean_deg: trunk.length ? rounded(Math.max(...trunk)) : null,
      mean_ankle_interior_angle_deg: rounded(mean(ankle)),
      horizontal_hip_excursion_body_heights: hipX.length && heights.length && mean(heights) > 0 ? rounded((Math.max(...hipX) - Math.min(...hipX)) / mean(heights)) : null,
      note: `2D side-view projection only. These are not 3D joint rotations, force-plate measures, or calibrated distances. Occlusion and camera angle affect results.${trial?.stance === 'single_leg' && cameraSide !== side ? ' The tested leg is on the far side of the iPad and may be obscured.' : ''}`,
    };
  }
  function drawStick(ctx, landmarks, width, height, nearSide = 'left') {
    ctx.clearRect(0, 0, width, height);
    const p = name => {
      const value = pointFrom(landmarks, name);
      return visible(value) ? { x: value.x * width, y: value.y * height } : null;
    };
    const segment = (a, b, color, lineWidth) => {
      const pa = p(a), pb = p(b);
      if (!pa || !pb) return;
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y);
      ctx.strokeStyle = color; ctx.lineWidth = lineWidth; ctx.lineCap = 'round'; ctx.stroke();
    };
    const other = nearSide === 'left' ? 'right' : 'left';
    const limb = (side, color, lineWidth) => {
      for (const [a, b] of [['shoulder', 'elbow'], ['elbow', 'wrist'], ['hip', 'knee'], ['knee', 'ankle'], ['ankle', 'foot_index']]) segment(`${side}_${a}`, `${side}_${b}`, color, lineWidth);
    };
    limb(other, '#96a7b5', 2);
    segment('left_shoulder', 'right_shoulder', '#0f9488', 3);
    segment('left_hip', 'right_hip', '#0f9488', 3);
    const shoulders = midpoint(p('left_shoulder'), p('right_shoulder'));
    const hips = midpoint(p('left_hip'), p('right_hip'));
    if (shoulders && hips) {
      ctx.beginPath(); ctx.moveTo(shoulders.x, shoulders.y); ctx.lineTo(hips.x, hips.y);
      ctx.strokeStyle = '#0f9488'; ctx.lineWidth = 4; ctx.stroke();
      const radius = Math.max(8, Math.hypot(shoulders.x - hips.x, shoulders.y - hips.y) * .22);
      ctx.beginPath(); ctx.arc(shoulders.x, shoulders.y - radius * 1.4, radius, 0, Math.PI * 2);
      ctx.strokeStyle = '#f2b134'; ctx.lineWidth = 3; ctx.stroke();
    }
    limb(nearSide, '#f2b134', 4);
  }
  global.SideView = { analyze, drawStick };
})(typeof window !== 'undefined' ? window : globalThis);
if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.SideView;
