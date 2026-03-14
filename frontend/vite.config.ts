import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:5120",
    },
  },
  preview: {
    port: 4173,
    proxy: {
      "/api": "http://localhost:5120",
    },
  },
  build: {
    outDir: "dist",
  },
});
