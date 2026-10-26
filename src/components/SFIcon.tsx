import React from 'react';
import { Platform, requireNativeComponent, View } from 'react-native';

type NativeSFIconProps = {
  symbolName: string;
  symbolTintColor: string;
  style?: { width: number; height: number };
};

const NativeSFIcon = Platform.OS === 'ios'
  ? requireNativeComponent<NativeSFIconProps>('SFSymbolView')
  : null;

export function SFIcon({
  name,
  color = '#FFFFFF',
  size = 18,
}: {
  name: string;
  color?: string;
  size?: number;
}) {
  if (!NativeSFIcon) {
    return <View accessibilityElementsHidden style={{ width: size, height: size }} />;
  }

  return (
    <NativeSFIcon
      symbolName={name}
      symbolTintColor={color}
      style={{ width: size, height: size }}
    />
  );
}

export function navigationSymbolName(maneuver: string): string {
  switch (maneuver) {
    case 'slight_right':
      return 'arrow.up.right';
    case 'right':
      return 'arrow.turn.up.right';
    case 'sharp_right':
      return 'arrow.turn.down.right';
    case 'slight_left':
      return 'arrow.up.left';
    case 'left':
      return 'arrow.turn.up.left';
    case 'sharp_left':
      return 'arrow.turn.down.left';
    case 'u_turn':
      return 'arrow.uturn.backward';
    case 'finish':
      return 'flag.checkered';
    default:
      return 'arrow.up';
  }
}
