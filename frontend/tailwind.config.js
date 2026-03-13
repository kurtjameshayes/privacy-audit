/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      keyframes: {
        "shrink-x": {
          "0%": { transform: "scaleX(1)" },
          "100%": { transform: "scaleX(0)" },
        },
      },
      animation: {
        "shrink-x": "shrink-x 6s linear forwards",
      },
    },
  },
  plugins: [],
  corePlugins: {
    preflight: false,
  },
}
