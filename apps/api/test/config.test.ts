import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { loadServerConfig } from '../src/config.js';

const environment = {
  LIVEKIT_URL: 'wss://livekit.example.test',
  LIVEKIT_API_KEY: 'test-key',
  LIVEKIT_API_SECRET: 'test-secret',
  LIVEKIT_TOKEN_TTL_SECONDS: '900',
  RATE_LIMIT_MAX: '30',
  RATE_LIMIT_WINDOW_MS: '60000',
  RATE_LIMIT_MAX_KEYS: '1000',
  PORT: '3000'
};

describe('server configuration', () => {
  it('loads a valid server configuration from an environment object', () => {
    expect(loadServerConfig(environment)).toMatchObject({
      port: 3000,
      apiConfig: {
        livekitUrl: 'wss://livekit.example.test/',
        tokenTtlSeconds: 900,
        rateLimit: { max: 30, timeWindowMs: 60_000, maxKeys: 1000 }
      }
    });
  });

  it.each([
    ['PORT', '0'],
    ['LIVEKIT_TOKEN_TTL_SECONDS', '0'],
    ['RATE_LIMIT_MAX', 'NaN'],
    ['RATE_LIMIT_WINDOW_MS', '-1'],
    ['RATE_LIMIT_MAX_KEYS', '1.5']
  ])('rejects an invalid positive integer for %s', (name, value) => {
    expect(() => loadServerConfig({ ...environment, [name]: value })).toThrow(`${name} must be a positive integer`);
  });

  it('rejects a non-WebSocket LiveKit URL', () => {
    expect(() => loadServerConfig({ ...environment, LIVEKIT_URL: 'https://livekit.example.test' })).toThrow('LIVEKIT_URL must be a ws or wss URL');
  });

  it('requires every LiveKit credential', () => {
    expect(() => loadServerConfig({ ...environment, LIVEKIT_API_SECRET: '' })).toThrow('Missing required environment variable: LIVEKIT_API_SECRET');
  });

  it('uses Node env-file loading for development and production scripts', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    expect(packageJson.scripts.dev).toContain('--env-file=.env');
    expect(packageJson.scripts.start).toContain('--env-file=.env');
  });
});
