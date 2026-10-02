/** @type {import('tailwindcss').Config} */
export default {
  // Tailwind only emits the utilities it can find in these files, so every
  // class used by the overlay/admin/auth components must live under ./src.
  content: ['./index.html', './src/**/*.{ts,tsx}'],

  theme: {
    extend: {
      colors: {
        // Semantic names from the design tokens in index.css
        ink:     '#e8ecf4',
        muted:   '#6b7a99',
        accent:  '#ff3333',
        accent2: '#ff6600',
        gold:    '#fbbf24',
        surface: 'rgba(6, 10, 20, 0.88)',
        deep:    '#000208',
      },

      fontFamily: {
        body: ['Outfit', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },

      boxShadow: {
        'glow-red':  '0 0 20px rgba(255, 51, 51, 0.35)',
        'glow-green': '0 0 24px rgba(34, 197, 94, 0.45)',
        'glow-gold': '0 0 20px rgba(251, 191, 36, 0.35)',
        panel:       '0 8px 32px rgba(0, 0, 0, 0.6)',
      },

      keyframes: {
        'fade-in':  { from: { opacity: '0', transform: 'translateY(8px)' },  to: { opacity: '1', transform: 'none' } },
        'slide-up': { from: { opacity: '0', transform: 'translateY(16px)' }, to: { opacity: '1', transform: 'none' } },
        shake: {
          '0%,100%': { transform: 'translate(0)' },
          '20%':     { transform: 'translate(-4px, 2px)' },
          '40%':     { transform: 'translate(4px, -2px)' },
          '60%':     { transform: 'translate(-3px, 3px)' },
          '80%':     { transform: 'translate(3px, -1px)' },
        },
        // Deliberately NOT named `pulse` — that would clobber Tailwind's own
        // animate-pulse, which other components rely on.
        breathe: {
          '0%,100%': { opacity: '1' },
          '50%':     { opacity: '0.45' },
        },
      },

      animation: {
        'fade-in':  'fade-in 0.3s ease forwards',
        'slide-up': 'slide-up 0.4s ease forwards',
        'shake':    'shake 0.5s ease',
        'breathe':  'breathe 1.5s ease-in-out infinite',
      },
    },
  },

  plugins: [],
};
