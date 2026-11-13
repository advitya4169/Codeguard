/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        cg: {
          background: 'var(--cg-background)',
          surface: 'var(--cg-surface)',
          raised: 'var(--cg-raised)',
          border: 'var(--cg-border)',
          primary: 'var(--cg-text-primary)',
          muted: 'var(--cg-text-muted)',
          accent: 'var(--cg-accent)',
          severity: {
            critical: 'var(--cg-severity-critical)',
            high: 'var(--cg-severity-high)',
            medium: 'var(--cg-severity-medium)',
            low: 'var(--cg-severity-low)',
            suggestion: 'var(--cg-severity-suggestion)',
          },
        },
      },
    },
  },
  plugins: [],
}
