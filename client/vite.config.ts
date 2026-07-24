import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The client talks directly to an agent over wss:// with a self-signed cert.
// Nothing special is needed here — the browser handles cert trust (the user
// visits the agent's https:// URL once to accept the cert).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
});
