import React from 'react';
import { Platform, requireNativeComponent } from 'react-native';
import type { MaterialDesignIconsIconName } from '@react-native-vector-icons/material-design-icons/static';

type NativeSFIconProps = {
  symbolName: string;
  symbolTintColor: string;
  style?: { width: number; height: number };
};

const NativeSFIcon = Platform.OS === 'ios'
  ? requireNativeComponent<NativeSFIconProps>('SFSymbolView')
  : null;

const AndroidMaterialIcon = Platform.OS === 'android'
  ? require('@react-native-vector-icons/material-design-icons/static').MaterialDesignIcons as
      typeof import('@react-native-vector-icons/material-design-icons/static').MaterialDesignIcons
  : null;

const androidIconNames: Record<string, MaterialDesignIconsIconName> = {
  'arrow.clockwise': 'refresh',
  'arrow.down.circle': 'arrow-down-circle-outline',
  'arrow.triangle.2.circlepath': 'sync',
  'arrow.up.circle.fill': 'arrow-up-circle',
  'arrow.up.right': 'arrow-top-right',
  'arrow.uturn.backward': 'arrow-u-left-top',
  'arrow.up': 'arrow-up',
  'arrow.up.left': 'arrow-top-left',
  'arrow.turn.up.right': 'arrow-top-right',
  'arrow.turn.down.right': 'arrow-bottom-right',
  'arrow.turn.up.left': 'arrow-top-left',
  'arrow.turn.down.left': 'arrow-bottom-left',
  'flag.checkered': 'flag-checkered',
  'bicycle': 'bike',
  'bolt.fill': 'lightning-bolt',
  'checkmark': 'check',
  'checkmark.circle.fill': 'check-circle',
  'checkmark.seal.fill': 'check-decagram',
  'chevron.left': 'chevron-left',
  'chevron.right': 'chevron-right',
  'chevron.up': 'chevron-up',
  'chevron.down': 'chevron-down',
  'circle': 'circle-outline',
  'cloud': 'cloud-outline',
  'exclamationmark.triangle.fill': 'alert',
  'figure.outdoor.cycle': 'bike',
  'folder': 'folder-outline',
  'folder.badge.plus': 'folder-plus-outline',
  'internaldrive': 'harddisk',
  'key.fill': 'key-variant',
  'lightbulb': 'lightbulb-outline',
  'link': 'link-variant',
  'link.badge.plus': 'link-plus',
  'location.north.fill': 'navigation',
  'location.north.line.fill': 'navigation-outline',
  'lock.fill': 'lock',
  'map.fill': 'map',
  'mountain.2': 'image-filter-hdr',
  'mountain.2.fill': 'image-filter-hdr',
  'person.crop.circle.fill': 'account-circle',
  'pause.fill': 'pause',
  'play.fill': 'play',
  'safari': 'web',
  'speaker.wave.2.fill': 'volume-high',
  'speaker.slash.fill': 'volume-off',
  'square.and.arrow.down': 'tray-arrow-down',
  'square.and.arrow.up': 'share-variant',
  'trash': 'delete-outline',
  'trash.fill': 'delete',
  'waveform.path.ecg': 'heart-pulse',
  'xmark': 'close',
  'xmark.circle.fill': 'close-circle',
};

export function SFIcon({
  name,
  color = '#FFFFFF',
  size = 18,
}: {
  name: string;
  color?: string;
  size?: number;
}) {
  if (Platform.OS === 'android' && AndroidMaterialIcon) {
    return (
      <AndroidMaterialIcon
        name={androidIconNames[name] ?? 'help-circle-outline'}
        color={color}
        size={size}
        accessibilityElementsHidden
      />
    );
  }

  if (!NativeSFIcon) {
    return null;
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
