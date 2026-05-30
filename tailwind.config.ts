import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        obsidian: "#070912",
        panel: "#0e1324",
        edge: "#1e2847",
        profit: "#35f1a3",
        danger: "#ff5577",
        warning: "#f7c35f"
      }
    }
  },
  plugins: []
};

export default config;
