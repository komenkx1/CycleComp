import { SaxesParser } from 'saxes';

export type RidePowerSummary = {
  averageWatts: number | null;
  coveredSeconds: number;
  sampleCount: number;
};

export function summarizeEstimatedPower(gpxXml: string): RidePowerSummary | null {
  const parser = new SaxesParser({ xmlns: true });
  const path: string[] = [];
  let elementText = '';
  let point: { timestamp: number | null; watts: number | null; estimated: boolean } | null = null;
  let previousSample: { timestamp: number; watts: number } | null = null;
  let coveredSeconds = 0;
  let wattSeconds = 0;
  let sampleCount = 0;
  let invalidXml = false;

  parser.on('error', () => { invalidXml = true; });
  parser.on('opentag', tag => {
    path.push(tag.local);
    elementText = '';
    if (tag.local === 'trkpt') point = { timestamp: null, watts: null, estimated: false };
  });
  parser.on('text', text => { elementText += text; });
  parser.on('closetag', tag => {
    if (point) {
      const parent = path[path.length - 2];
      if (tag.local === 'time' && parent === 'trkpt') {
        const timestamp = Date.parse(elementText.trim());
        point.timestamp = Number.isFinite(timestamp) ? timestamp : null;
      } else if (tag.local === 'power' && parent === 'extensions' && elementText.trim()) {
        const watts = Number(elementText.trim());
        point.watts = Number.isFinite(watts) && watts >= 0 ? watts : null;
      } else if (tag.local === 'powerSource' && tag.uri === 'https://mangwahyu.tech/cyclecomp/gpx/1') {
        point.estimated = elementText.trim() === 'estimated';
      } else if (tag.local === 'trkpt') {
        if (point.estimated && point.timestamp != null && point.watts != null) {
          sampleCount += 1;
          if (previousSample) {
            const seconds = (point.timestamp - previousSample.timestamp) / 1000;
            if (seconds > 0 && seconds <= 10) {
              wattSeconds += (point.watts + previousSample.watts) / 2 * seconds;
              coveredSeconds += seconds;
            }
          }
          previousSample = { timestamp: point.timestamp, watts: point.watts };
        } else {
          previousSample = null;
        }
        point = null;
      }
    }
    if (tag.local === 'trkseg') previousSample = null;
    path.pop();
    elementText = '';
  });
  try { parser.write(gpxXml).close(); } catch { return null; }
  if (invalidXml || sampleCount === 0) return null;
  return { averageWatts: coveredSeconds > 0 ? wattSeconds / coveredSeconds : null, coveredSeconds, sampleCount };
}
