import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.js',
    globals: true,
    // Test files were flaky when run together (intermittent waitFor timeouts
    // in Settings.test.jsx) but 100% reliable in isolation — a cross-file
    // global-state leak under parallel execution (likely vi.useFakeTimers in
    // FixCard.test.jsx bleeding into another file's real-timer waitFor calls).
    // Same fix as the backend's --test-concurrency=1: run files sequentially.
    fileParallelism: false,
  },
})
