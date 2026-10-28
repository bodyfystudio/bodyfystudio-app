import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    // Avoid esbuild's parent-directory scan in locked-down Windows/OneDrive workspaces.
    noDiscovery: true,
  },
});
