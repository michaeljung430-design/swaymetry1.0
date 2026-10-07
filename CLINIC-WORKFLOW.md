# Clinic workflow prototype

This version preserves the October 5 simplified phone sensor screen. It adds a deterministic session report, observer notes, printing/copying, and comparison against a locally saved visit for the same participant code.

## Use

1. Enter an anonymous participant code before testing. Use the same code on future visits.
2. Keep camera framing, footwear, phone mounting and protocol consistent. The side camera remains optional.
3. Record trials. Open Results for the session report, even without an AI API key.
4. Check usable-run counts and recording warnings. Add observer notes, then save the visit on this device and download the JSON backup.
5. For a subsequent visit, select a previous saved visit in the report. Changes are today minus previous, with usable-run counts shown separately.

## Measurement changes

Front-camera angles now use video aspect ratio and 2D geometry rather than mixing normalized axes or estimated depth. Old raw records are not rewritten. Old angle calculations do not enter the new report. Each new run records its calculation version, acceleration source and timing coverage.

Report engineering checks require at least 80% usable sensor readings, recording coverage reaching 90% of the selected duration, a start within one second and no gap over 0.5 seconds. These thresholds are prototype data checks, not validated clinical standards. Phone metrics require gravity-free linear acceleration. Missing, mixed and gravity-including sources are excluded. Side metrics require the existing complete-side-capture check.

## Limits and remaining work

Reports are descriptive and may span multiple printed pages. No normal/abnormal classification or validated minimum detectable change is claimed. The advanced legacy calculations remain available for inspection. Observer-confirmed foot contacts are not automatically inferred. Screen locking, institutional access controls, secure cloud patient storage, cross-device backups and clinic account administration are not implemented. Browser storage is not a clinical record system. Do not use identifiable patient information in a pilot until privacy, security and clinical governance have been reviewed.

Clinical accuracy still needs matched reference testing. Device synchronization remains dependent on the existing relay control timestamps, not a validated shared hardware clock. Do not claim laboratory-equivalent accuracy.

## Local checks

Run `node --test clinic-report.test.js`. Existing validation and side-view tests from the local packaging workspace can also run against this source. Real iPhone/iPad permission flows, print layouts and in-clinic usability need device testing.

## Commercial pilot

Observe five therapists using the prototype. Record setup time, failed trials, report editing time, frequency of use and willingness to pay. Validate the specific measurements they find useful through the research lab before advertising clinical accuracy. A paid pilot should have an agreed scope and privacy arrangements; this code does not establish compliance or clinical validity.
