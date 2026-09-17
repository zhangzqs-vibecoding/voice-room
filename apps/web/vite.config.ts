import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({ plugins: [react()], test: { environment: 'jsdom', globals: true, include: ['test/**/*.test.ts', 'test/**/*.test.tsx'], setupFiles: ['./test/setup.ts'] } });
