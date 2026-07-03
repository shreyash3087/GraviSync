/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: {
          primary: '#0a0a0f',
          elevated: '#14141f',
          glass: 'rgba(255,255,255,0.04)',
        },
        accent: {
          DEFAULT: '#6366f1',
          hover: '#4f46e5',
        },
        neutral: 'rgba(255,255,255,0.05)',
      },
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
