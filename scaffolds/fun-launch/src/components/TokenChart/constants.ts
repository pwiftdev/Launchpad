import { BRAND } from '@/constants/brand';

export type ChartThemeColors = {
  /** Chart pane background */
  bg: string;
  /** Chart grid line color */
  grid: string;
  /** Accent color used for highlighted header buttons */
  accent: string;
};

export const CHART_THEME_COLORS: Record<'dark' | 'light', ChartThemeColors> = {
  dark: {
    bg: BRAND.colors.surface,
    grid: '#1a1a1a',
    accent: BRAND.colors.orange,
  },
  light: {
    bg: '#ffffff',
    grid: '#e5e5e5',
    accent: BRAND.colors.black,
  },
};
