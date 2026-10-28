import { defineConfig } from 'vite';

const appBuildId = `${process.env.VERCEL_GIT_COMMIT_SHA || 'local'}-${Date.now()}`;

export default defineConfig({
  define: {
    __APP_BUILD_ID__: JSON.stringify(appBuildId),
  },
  plugins: [{
    name: 'bodyfy-build-info',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({ buildId: appBuildId }),
      });
    },
  }],
  optimizeDeps: {
    // Avoid esbuild's parent-directory scan in locked-down Windows/OneDrive workspaces.
    noDiscovery: true,
  },
});
