const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('./clinic-report.js');
const A = require('./assessment.js');
const B = require('./biomechanics.js');
test('participant restoration happens after session initialization',()=>{
  const html=require('node:fs').readFileSync(require('node:path').join(__dirname,'movement-sensor-diagnostics.html'),'utf8');
  assert.ok(html.indexOf("$('protocol-participant-code').value=currentAssessment.participant_code")>html.indexOf('currentAssessment=loadAssessment();'));
});
test('horizontal pelvis does not become 180 degrees when landmark order reverses',()=>{
  assert.equal(B.calculateTilt({x:1,y:0},{x:0,y:0}),0);
  assert.equal(B.calculateTilt({x:0,y:0},{x:1,y:0}),0);
});
function trial(overrides = {}) {
  return { trial_name:'right_leg_eyes_open_rep_1', condition_id:'right_leg_eyes_open', status:'completed', duration_seconds:30, measurement_version:R.VERSION,
    phone_acceleration_source:'linear_acceleration', data_quality:{camera_tracking_quality:1,phone_tracking_quality:1},
    capture_coverage:{camera:{sufficient:true,max_gap_seconds:0.1},phone:{sufficient:true,max_gap_seconds:0.1}},
    protocol_context:{participant_code:'P001',camera_view:'front',phone_placement:'L5 vertical'},
    phone_balance:{total_sway:0.3,mean_sway_velocity:0.4}, camera_posture:{right_knee:{mean_frontal_deviation_deg:2}}, ...overrides };
}
test('unknown or gravity-including phone readings are excluded',()=>{
  for(const source of ['unknown','mixed','including_gravity']) assert.ok(R.quality(trial({phone_acceleration_source:source}),'phone'));
  assert.equal(R.quality(trial(),'phone'),null);
});
test('poor tracking and gaps are excluded independently per sensor',()=>{
  const t=trial({data_quality:{camera_tracking_quality:0.5,phone_tracking_quality:1}});
  assert.ok(R.quality(t,'camera'));assert.equal(R.quality(t,'phone'),null);
  assert.ok(R.quality(trial({capture_coverage:{camera:{sufficient:true,max_gap_seconds:2}}}),'camera'));
});
test('legacy angles remain stored but cannot enter new comparisons',()=>assert.ok(R.quality(trial({measurement_version:null}),'camera')));
test('zero is a measurement, missing is unavailable, one run has no SD',()=>{
  const g=R.summarize({trials:[trial({phone_balance:{total_sway:0}})]})[0];
  assert.deepEqual(g.values.rms,{n:1,mean:0,sd:null});assert.equal(g.values.jerk.n,0);
});
test('only same-participant same-protocol visits compare',()=>{
  const old={trials:[trial()]}, now={trials:[trial({phone_balance:{total_sway:0.4}})]};
  assert.ok(Math.abs(R.compare(now,old).rows.find(r=>r.unit==='m/s²').change-0.1)<1e-9);
  assert.ok(R.compare({participant_code:'P002',trials:[trial()]},old).reason);
  assert.ok(R.compare({trials:[trial({duration_seconds:20})]},old).reason);
});
test('coverage detects partial recordings and sparse gaps',()=>{
  assert.equal(R.coverage([{timestamp_seconds:5},{timestamp_seconds:10}],30).sufficient,false);
  assert.equal(R.coverage([],30).sufficient,false);
  assert.ok(R.coverage([{timestamp_seconds:0},{timestamp_seconds:30}],30).max_gap_seconds>0.5);
});
test('aspect-corrected front geometry excludes missing video dimensions',()=>{
  const landmarks=Object.fromEntries(Object.keys(A.LANDMARK_INDEX).map(name=>[name,{x:0.5,y:0.5,confidence:1}]));
  Object.assign(landmarks,{left_hip:{x:0.4,y:0.6,confidence:1},right_hip:{x:0.6,y:0.6,confidence:1},left_shoulder:{x:0.5,y:0.2,confidence:1},right_shoulder:{x:0.7,y:0.2,confidence:1}});
  const frames=Array.from({length:10},(_,i)=>({timestamp_seconds:i/10,landmarks,image_width:1600,image_height:900}));
  const expected=Math.atan2(0.1*1600,0.4*900)*180/Math.PI;
  assert.ok(Math.abs(A.computeCameraMetrics(frames,A.TRIALS[0]).posture.trunk.mean_lean-expected)<0.001);
  assert.equal(A.computeCameraMetrics(frames.map(f=>({...f,image_width:null})),A.TRIALS[0]).posture.trunk.mean_lean,null);
});
