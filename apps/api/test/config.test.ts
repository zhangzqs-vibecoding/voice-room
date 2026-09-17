import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { loadServerConfig } from '../src/config.js';

const execFileAsync = promisify(execFile);

const environment = {
  LIVEKIT_URL: 'wss://livekit.example.test',
  LIVEKIT_PUBLIC_URL: 'wss://voice.example.test',
  LIVEKIT_API_KEY: 'test-key',
  LIVEKIT_API_SECRET: 'test-secret',
  LIVEKIT_TOKEN_TTL_SECONDS: '900',
  RATE_LIMIT_MAX: '30',
  RATE_LIMIT_WINDOW_MS: '60000',
  RATE_LIMIT_MAX_KEYS: '1000',
  MAX_KNOWN_ROOMS: '100',
  ROOM_SWEEP_TIMEOUT_MS: '100',
  LIVEKIT_REQUEST_TIMEOUT_MS: '1000',
  TRUSTED_PROXY_CIDRS: '127.0.0.1/32,10.0.0.0/8',
  PORT: '3000'
};

describe('server configuration', () => {
  it('loads a valid server configuration from an environment object', () => {
    expect(loadServerConfig(environment)).toMatchObject({
      port: 3000,
      apiConfig: {
        livekitUrl: 'wss://livekit.example.test/',
        livekitPublicUrl: 'wss://voice.example.test/',
        tokenTtlSeconds: 900,
        rateLimit: { max: 30, timeWindowMs: 60_000, maxKeys: 1000 },
        roomCacheMaxEntries: 100,
        roomSweepTimeoutMs: 100,
        livekitRequestTimeoutMs: 1000,
        trustedProxyCidrs: ['127.0.0.1/32', '10.0.0.0/8']
      }
    });
  });

  it.each([
    ['PORT', '0'],
    ['LIVEKIT_TOKEN_TTL_SECONDS', '0'],
    ['RATE_LIMIT_MAX', 'NaN'],
    ['RATE_LIMIT_WINDOW_MS', '-1'],
    ['RATE_LIMIT_MAX_KEYS', '1.5'],
    ['MAX_KNOWN_ROOMS', '0'],
    ['ROOM_SWEEP_TIMEOUT_MS', '0'],
    ['LIVEKIT_REQUEST_TIMEOUT_MS', '0']
  ])('rejects an invalid positive integer for %s', (name, value) => {
    expect(() => loadServerConfig({ ...environment, [name]: value })).toThrow(`${name} must be a positive integer`);
  });

  it.each(['1', '999', '1001'])('rejects a LiveKit request timeout that is not a whole second', (value) => {
    expect(() => loadServerConfig({ ...environment, LIVEKIT_REQUEST_TIMEOUT_MS: value })).toThrow('LIVEKIT_REQUEST_TIMEOUT_MS must be a positive multiple of 1000');
  });

  it.each(['1000', '2000'])('accepts a whole-second LiveKit request timeout', (value) => {
    expect(loadServerConfig({ ...environment, LIVEKIT_REQUEST_TIMEOUT_MS: value }).apiConfig.livekitRequestTimeoutMs).toBe(Number(value));
  });

  it('keeps the internal RoomService URL separate from the browser-facing LiveKit URL', () => {
    const config = loadServerConfig({ ...environment, LIVEKIT_URL: 'ws://livekit:7880', LIVEKIT_PUBLIC_URL: 'wss://voice.example.test' });
    expect(config.apiConfig.livekitUrl).toBe('ws://livekit:7880/');
    expect(config.apiConfig.livekitPublicUrl).toBe('wss://voice.example.test/');
  });

  it.each(['LIVEKIT_URL', 'LIVEKIT_PUBLIC_URL'])('rejects a non-WebSocket %s', (name) => {
    expect(() => loadServerConfig({ ...environment, [name]: 'https://livekit.example.test' })).toThrow(`${name} must be a ws or wss URL`);
  });

  it('rejects an invalid trusted proxy CIDR', () => {
    expect(() => loadServerConfig({ ...environment, TRUSTED_PROXY_CIDRS: 'not-a-cidr' })).toThrow('TRUSTED_PROXY_CIDRS contains an invalid IP or CIDR');
  });

  it.each(['0.0.0.0/0', '::/0'])('rejects a trusted proxy CIDR that trusts every address', (cidr) => {
    expect(() => loadServerConfig({ ...environment, TRUSTED_PROXY_CIDRS: cidr })).toThrow('TRUSTED_PROXY_CIDRS contains an invalid IP or CIDR');
  });

  it('requires every LiveKit credential', () => {
    expect(() => loadServerConfig({ ...environment, LIVEKIT_API_SECRET: '' })).toThrow('Missing required environment variable: LIVEKIT_API_SECRET');
  });

  it('loads the root env file when Node starts from the API directory', async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'voice-room-env-'));
    const apiDirectory = join(fixtureRoot, 'apps', 'api');
    await mkdir(apiDirectory, { recursive: true });
    await writeFile(join(fixtureRoot, '.env'), 'LIVEKIT_API_KEY=fixture-key\n');
    try {
      const { stdout } = await execFileAsync(process.execPath, [
        '--env-file=../../.env',
        '--input-type=module',
        '--eval',
        'process.stdout.write(process.env.LIVEKIT_API_KEY ?? "")'
      ], { cwd: apiDirectory });
      expect(stdout).toBe('fixture-key');
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('uses the root env file in development and production scripts', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    expect(packageJson.scripts.dev).toContain('--env-file=../../.env');
    expect(packageJson.scripts.dev).toContain('--import tsx');
    expect(packageJson.scripts.start).toContain('--env-file=../../.env');
  });
});
