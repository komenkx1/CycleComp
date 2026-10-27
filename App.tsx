import { useEffect } from 'react';
import { NativeModules, StatusBar, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { RoutePreviewScreen } from './src/features/routes/RoutePreviewScreen';
import { AmoledTheme } from './src/theme/colors';
import { restoreTerrainAreaTransfer } from './src/features/elevation/terrainAreaTransfer';

// Matikan gesture goyangan (shake) menu developer agar getaran setang sepeda di jalan tidak memicu popup
if (__DEV__) {
  NativeModules.DevSettings?.setIsShakeToShowDevMenuEnabled?.(false);
}

function App() {
  useEffect(() => {
    restoreTerrainAreaTransfer();
  }, []);
  return (
    <SafeAreaProvider style={styles.container}>
      <StatusBar barStyle="light-content" />
      <RoutePreviewScreen />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: AmoledTheme.background,
    flex: 1,
  },
});

export default App;
