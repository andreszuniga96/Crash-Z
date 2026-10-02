import { defineConfig } from 'vite';
import react            from '@vitejs/plugin-react';
import path             from 'path';

export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },

  server: {
    port: 5173,
    proxy: {
      // Proxy REST API calls to the Node server
      '/api': {
        target:    'http://localhost:3001',
        changeOrigin: true,
      },
      // Proxy Socket.IO WebSocket upgrade
      '/socket.io': {
        target:  'http://localhost:3001',
        ws:      true,
        changeOrigin: true,
      },
    },
  },

  build: {
    target:         'es2022',
    sourcemap:      true,
    rollupOptions: {
      output: {
        manualChunks: {
          // `three` and `three/webgpu` MUST land in the same chunk. Splitting
          // them across chunks risks loading two copies of the core module,
          // which breaks the renderer's class-identity checks.
          //
          // The GLTF/DRACO loaders import from `'three'`, i.e. through
          // `three.module.js` → `three.core.js`. `three/webgpu` imports the very
          // same `three.core.js`, so both entries share ONE copy of every class
          // and `instanceof` checks keep working. Listing the loaders here too
          // just guarantees they land in this chunk with their core module.
          'three':       [
            'three',
            'three/webgpu',
            'three/examples/jsm/loaders/GLTFLoader.js',
            'three/examples/jsm/loaders/DRACOLoader.js',
          ],
          'react-vendor': ['react', 'react-dom'],
          'socket':      ['socket.io-client'],
        },
      },
    },
  },

  optimizeDeps: {
    // Pre-bundle Three.js WebGPU module and the GLTF/DRACO loaders to avoid
    // Vite transform issues (the loaders ship as unbundled ESM sources).
    include: [
      'three',
      'three/webgpu',
      'three/examples/jsm/loaders/GLTFLoader.js',
      'three/examples/jsm/loaders/DRACOLoader.js',
    ],
  },
});
