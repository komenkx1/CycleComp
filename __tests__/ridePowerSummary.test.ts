import { summarizeEstimatedPower } from '../src/features/history/ridePowerSummary';

function point(time: string, watts?: number, estimated = true) {
  return `<trkpt lat="0" lon="0"><time>${time}</time><extensions>${watts == null ? '' : `<power>${watts}</power>`}${estimated ? '<cyclecomp:powerSource>estimated</cyclecomp:powerSource>' : ''}</extensions></trkpt>`;
}

test('averages only adjacent estimated samples, excluding gaps and segment boundaries', () => {
  const gpx = `<gpx xmlns="http://www.topografix.com/GPX/1/1" xmlns:cyclecomp="https://mangwahyu.tech/cyclecomp/gpx/1"><trk><trkseg>
    ${point('2026-01-01T00:00:00Z', 100)}${point('2026-01-01T00:00:02Z', 200)}
    ${point('2026-01-01T00:00:03Z')}${point('2026-01-01T00:00:04Z', 800)}
    ${point('2026-01-01T00:00:30Z', 500)}
    </trkseg><trkseg>${point('2026-01-01T00:00:31Z', 900)}</trkseg></trk></gpx>`;
  expect(summarizeEstimatedPower(gpx)).toEqual({ averageWatts: 150, coveredSeconds: 2, sampleCount: 5 });
});

test('ignores power without CycleComp estimated provenance', () => {
  const gpx = `<gpx xmlns:cyclecomp="https://mangwahyu.tech/cyclecomp/gpx/1"><trk><trkseg>${point('2026-01-01T00:00:00Z', 200, false)}</trkseg></trk></gpx>`;
  expect(summarizeEstimatedPower(gpx)).toBeNull();
  expect(summarizeEstimatedPower('<gpx><trk>')).toBeNull();
});
