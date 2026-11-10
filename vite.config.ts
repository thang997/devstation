import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
    // Không watch src-tauri: cargo ghi .exe trong target/ làm Windows khoá file → EBUSY.
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: { target: "es2022" },
});
