import { NativeModules } from 'react-native';
import type { GpxRoute } from '../../domain/routes/gpx/GpxRoute';

type SavedRideRoute = { rideId: string; route: GpxRoute };

export async function saveActiveRideRoute(rideId: string, route: GpxRoute): Promise<void> {
  if (!NativeModules.RideTracking?.setActiveRideRoute) throw new Error('Penyimpanan rute belum tersedia.');
  await NativeModules.RideTracking.setActiveRideRoute(JSON.stringify({ rideId, route }));
}

export async function loadActiveRideRoute(rideId: string): Promise<GpxRoute | null> {
  if (!NativeModules.RideTracking?.getActiveRideRoute) return null;
  const routeJSON = await NativeModules.RideTracking.getActiveRideRoute();
  if (!routeJSON) return null;
  const savedRoute = JSON.parse(routeJSON) as SavedRideRoute;
  return savedRoute.rideId === rideId ? savedRoute.route : null;
}
