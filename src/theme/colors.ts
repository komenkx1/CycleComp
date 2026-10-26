/**
 * AMOLED Dark Theme Design System for CycleComp
 * 
 * Specifically optimized for OLED displays.
 * True pitch black (#000000) shuts off individual OLED pixels completely,
 * yielding 0 power draw and maximum battery life during long bike rides.
 */

export const AmoledTheme = {
  // Pure AMOLED Blacks (Pixels turn off completely on OLED)
  background: '#000000',
  card: '#000000',
  surfaceElevated: '#0C0C0E',
  surfaceInteractive: '#161618',
  surfaceInteractiveActive: '#222226',
  
  // Borders & Dividers (Subtle, crisp hairline borders for AMOLED depth)
  borderSubtle: 'rgba(255, 255, 255, 0.08)',
  borderDefault: 'rgba(255, 255, 255, 0.14)',
  borderEmphasized: 'rgba(255, 255, 255, 0.22)',
  divider: 'rgba(255, 255, 255, 0.16)',
  
  // High-Contrast AMOLED Typography (Maximum sunlight legibility)
  textPrimary: '#FFFFFF',
  textSecondary: '#98989D',
  textTertiary: '#636366',
  textDisabled: '#48484A',
  
  // High-Visibility OLED Accents (Garmin / Apple Fitness style)
  accentOrange: '#FF5E00',       // High-visibility solar orange
  accentOrangeGlow: 'rgba(255, 94, 0, 0.35)',
  accentGreen: '#30D158',        // Active GPS / Live status
  accentYellow: '#FFD60A',       // Paused status
  accentRed: '#FF453A',          // Error / Critical
  accentBlue: '#0A84FF',         // Area selection frame
  accentBlueFill: 'rgba(10, 132, 255, 0.15)',
  
  // Glass HUD Overlays & Modals
  overlayBackground: 'rgba(0, 0, 0, 0.90)',
  modalBackdrop: 'rgba(0, 0, 0, 0.78)',
} as const;
