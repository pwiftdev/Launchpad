import plugin from 'tailwindcss/plugin';
import tailwindcssAnimate from 'tailwindcss-animate';
import { addIconSelectors } from '@iconify/tailwind';

/**
 * Resolve a color from a CSS variable (RGB triplet) with alpha support.
 * The variables are defined per-theme in `src/styles/globals.css`.
 */
const themeVar = (name) => `rgb(var(--${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{js,ts,jsx,tsx}'],
  darkMode: ['class'],
  theme: {
    extend: {
      screens: {
        xs: '390px',
      },

      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['var(--font-display)', 'var(--font-sans)', 'ui-sans-serif', 'sans-serif'],
        // Numbers and addresses use Inter with tabular figures: equal-width digits like a mono font,
        // without the dotted zero that reads as an 8 at small sizes
        mono: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        // Terminal face for labels, buttons, headings and the boot log
        term: ['var(--font-term)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
        pixel: ['var(--font-pixel)', 'ui-monospace', 'monospace'],
        code: ['var(--font-code)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },

      // Brutalist: no rounded corners anywhere. Only rounded-full survives, for status dots.
      borderRadius: {
        none: '0',
        sm: '0',
        DEFAULT: '0',
        md: '0',
        lg: '0',
        xl: '0',
        '2xl': '0',
        '3xl': '0',
      },

      fontSize: {
        '2xs': ['0.625rem', { lineHeight: '0.75rem' }],
        xxs: ['0.5rem', { lineHeight: '0.625rem' }],
      },

      backgroundSize: {
        '200-auto': '200% auto',
      },

      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'fade-out': {
          from: { opacity: '1' },
          to: { opacity: '0' },
        },
        shine: {
          from: { backgroundPosition: '200% center' },
          to: { backgroundPosition: '-200% center' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-6px)' },
        },
        // Name kept for existing call sites; now a short glitch jitter
        pray: {
          '0%, 100%': { transform: 'translate(0, 0)' },
          '20%': { transform: 'translate(-1px, 1px)' },
          '40%': { transform: 'translate(1px, -1px)' },
          '60%': { transform: 'translate(-1px, 0)' },
          '80%': { transform: 'translate(1px, 1px)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.15s ease-out forwards',
        'fade-out': 'fade-out 0.15s ease-in forwards',
        'shine-reverse': 'shine 3s linear infinite reverse',
        float: 'float 3.5s ease-in-out infinite',
        pray: 'pray 0.35s steps(2) infinite',
      },

      colors: {
        background: themeVar('background'),
        foreground: themeVar('foreground'),
        accent: themeVar('accent'),

        // MASKED: signal yellow is the only accent. `signal` is the raw yellow for fills
        // (same in both themes); `acid` is the accent as text (yellow on black, deep gold on white).
        signal: themeVar('signal'),
        // Solid panel fill: every surface that sits on the background
        panel: themeVar('panel'),
        acid: themeVar('lime'),
        // Legacy brand names, now monochrome (see globals.css)
        cobalt: themeVar('cobalt'),
        cyan: themeVar('cyan'),
        'brand-violet': themeVar('violet'),
        soap: themeVar('primary'),
        bubble: themeVar('accent'),
        ink: '#000000',

        // Theme-aware scales (inverted between light and dark mode)
        neutral: {
          50: themeVar('neutral-50'),
          100: themeVar('neutral-100'),
          200: themeVar('neutral-200'),
          300: themeVar('neutral-300'),
          400: themeVar('neutral-400'),
          500: themeVar('neutral-500'),
          600: themeVar('neutral-600'),
          700: themeVar('neutral-700'),
          750: themeVar('neutral-750'),
          800: themeVar('neutral-800'),
          850: themeVar('neutral-850'),
          900: themeVar('neutral-900'),
          925: themeVar('neutral-925'),
          950: themeVar('neutral-950'),
        },
        primary: {
          DEFAULT: themeVar('primary'),
          200: themeVar('primary-200'),
          300: themeVar('primary-300'),
          400: themeVar('primary-400'),
          500: themeVar('primary-500'),
          600: themeVar('primary-600'),
          700: themeVar('primary-700'),
          800: themeVar('primary-800'),
          900: themeVar('primary-900'),
          950: themeVar('primary-950'),
        },

        // Status colors: theme-aware DEFAULT, static shades
        amber: {
          50: '#fffbeb',
          100: '#fef3c6',
          200: '#fee685',
          300: '#ffd230',
          400: '#ffb900',
          DEFAULT: themeVar('amber'),
          500: '#fe9a00',
          600: '#e17100',
          700: '#bb4d00',
          800: '#973c00',
          900: '#7b3306',
          950: '#461901',
        },
        emerald: {
          50: '#ecfdf5',
          100: '#d0fae5',
          200: '#a4f4cf',
          300: '#5ee9b5',
          400: '#3ce3ab',
          DEFAULT: themeVar('emerald'),
          500: '#02c78c',
          600: '#00a272',
          700: '#00815f',
          800: '#00664c',
          900: '#005440',
          950: '#002f25',
        },
        rose: {
          50: '#fff1f4',
          100: '#ffe4ea',
          200: '#fecddb',
          300: '#fca5bd',
          400: '#f23674',
          DEFAULT: themeVar('rose'),
          500: '#eb2d6f',
          600: '#e01e68',
          700: '#bd1358',
          800: '#9e134f',
          900: '#871449',
          950: '#4b0624',
        },
      },
    },
  },
  plugins: [
    tailwindcssAnimate,
    // Iconify plugin for clean selectors, requires writing a list of icon sets to load
    // Icons usage in HTML:
    //  <span class="iconify [icon-set]--[icon]"></span>
    //  <span class="iconify ph--airplane-tilt-fill"></span>
    addIconSelectors({
      // List of icon sets
      prefixes: ['ph'],
    }),
    plugin(({ addUtilities, addVariant }) => {
      // Only apply hover styles on devices that actually support hover
      addVariant('has-hover', '@media (hover: hover) and (pointer: fine)');

      addUtilities({
        '.scrollbar-none': {
          'scrollbar-width': 'none',
          '-ms-overflow-style': 'none',
          '&::-webkit-scrollbar': {
            display: 'none',
          },
        },
      });
    }),
  ],
};
