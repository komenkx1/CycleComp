import type { GpxRoute } from '../../domain/routes/gpx/GpxRoute';
import {
  createRecordedRouteBack,
  reverseRouteForReturn,
  type RecordedRoutePoint,
} from '../../domain/routes/gpx/routeBack';
import { enrichGpxRouteFromOfflineTerrain } from '../elevation/enrichGpxRouteFromOfflineTerrain';

export type OfflineTerrainRouteEnricher = (route: GpxRoute) => Promise<GpxRoute>;

export async function prepareRecordedRouteBack(
  recordedTrackSegments: RecordedRoutePoint[][],
  enrichRoute: OfflineTerrainRouteEnricher = enrichGpxRouteFromOfflineTerrain,
): Promise<{ forwardRoute: GpxRoute; returnRoute: GpxRoute } | null> {
  const recordedRouteBack = createRecordedRouteBack(recordedTrackSegments);
  if (!recordedRouteBack) {
    return null;
  }

  const forwardRoute = await enrichRoute(recordedRouteBack.forwardRoute);
  return {
    forwardRoute,
    returnRoute: reverseRouteForReturn(forwardRoute),
  };
}
