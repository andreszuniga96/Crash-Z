// The client package is `"type": "module"`, so this config is ESM.
// Vite resolves it relative to the package root (packages/client), which is
// also the CWD when `npm run build --workspace=packages/client` executes.
export default {
  plugins: {
    tailwindcss:  {},
    autoprefixer: {},
  },
};
