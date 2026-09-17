import type { ApiConfig } from './app.js';

export interface ServerConfig {
  apiConfig: ApiConfig;
  port: number;
}

const required = (environment: NodeJS.ProcessEnv, name: string): string => {
  const value = environment[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

const positiveInteger = (environment: NodeJS.ProcessEnv, name: string, fallback: string): number => {
  const value = environment[name] ?? fallback;
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a positive integer`);
  return parsed;
};

const parseLiveKitUrl = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('LIVEKIT_URL must be a ws or wss URL');
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('LIVEKIT_URL must be a ws or wss URL');
  return url.toString();
};

const boolean = (environment: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean => {
  const value = environment[name];
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false`);
};

export const loadServerConfig = (environment: NodeJS.ProcessEnv): ServerConfig => {
  const port = positiveInteger(environment, 'PORT', '3000');
  if (port > 65_535) throw new Error('PORT must be a positive integer');
  return {
    port,
    apiConfig: {
      livekitUrl: parseLiveKitUrl(required(environment, 'LIVEKIT_URL')),
      apiKey: required(environment, 'LIVEKIT_API_KEY'),
      apiSecret: required(environment, 'LIVEKIT_API_SECRET'),
      tokenTtlSeconds: positiveInteger(environment, 'LIVEKIT_TOKEN_TTL_SECONDS', '900'),
      roomCacheMaxEntries: positiveInteger(environment, 'MAX_KNOWN_ROOMS', '10000'),
      trustProxy: boolean(environment, 'TRUST_PROXY', false),
      rateLimit: {
        max: positiveInteger(environment, 'RATE_LIMIT_MAX', '30'),
        timeWindowMs: positiveInteger(environment, 'RATE_LIMIT_WINDOW_MS', '60000'),
        maxKeys: positiveInteger(environment, 'RATE_LIMIT_MAX_KEYS', '10000')
      }
    }
  };
};
