import React from 'react';
import { Platform, Switch, type SwitchProps } from 'react-native';

import { AmoledTheme } from '../theme/colors';

export function AmoledSwitch(props: SwitchProps) {
  if (Platform.OS !== 'android') return <Switch {...props} />;

  return (
    <Switch
      {...props}
      trackColor={{ false: '#3A3A3C', true: AmoledTheme.accentOrange }}
      thumbColor={props.value ? '#FFFFFF' : '#C7C7CC'}
    />
  );
}
