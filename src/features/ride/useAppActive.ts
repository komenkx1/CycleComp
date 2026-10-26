import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

export function useAppActive() {
  const [appActive, setAppActive] = useState(AppState.currentState !== 'background');

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      // A permission dialog can briefly make iOS inactive without hiding the map.
      if (state === 'active' || state === 'background') {
        setAppActive(state === 'active');
      }
    });
    return () => subscription.remove();
  }, []);

  return appActive;
}
