import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}"
  ],
  theme: {
    extend: {
      colors: {
        background: "#050711",
        surface: "#0B0E1A",
        surfaceMuted: "#101320",
        accent: "#4ADE80",
        accentSoft: "#1B2D1F",
        danger: "#F97373",
        border: "#1F2435",
        textPrimary: "#F9FAFB",
        textSecondary: "#9CA3AF"
      },
      boxShadow: {
        "xl-soft":
          "0 28px 80px rgba(0,0,0,0.65), 0 0 0 1px rgba(148, 163, 184, 0.2)"
      },
      borderRadius: {
        "2xl": "1.25rem"
      }
    }
  },
  plugins: []
};

export default config;

