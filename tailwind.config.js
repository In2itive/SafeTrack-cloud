/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './App.tsx', './components/**/*.tsx', './contexts/**/*.tsx'],
  theme: {
    extend: {
      colors: {
        church: {
          50: '#eef4ff',
          100: '#dbe7fe',
          500: '#5c9bf8',
          600: '#3f7ae6',
          800: '#3b5bb6', // was '#3b5kb6' (invalid hex) in the AI Studio config, so hover states never rendered
          900: '#2a48a0',
          gold: '#eab308',
        },
      },
    },
  },
  plugins: [],
};
