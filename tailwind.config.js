/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'primary': '#4F46E5',
        'primary-hover': '#4338CA',
        'sidebar': '#1E1E2E',
        'sidebar-hover': '#2A2A3E',
        'content': '#252536',
        'card': '#2A2A3E',
        'text-primary': '#E4E4E7',
        'text-secondary': '#A1A1AA',
        'border-color': '#3F3F5A',
      }
    },
  },
  plugins: [],
}
