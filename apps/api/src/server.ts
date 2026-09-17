import { createApp, type ApiConfig } from './app.js';
import { LiveKitServerGateway } from './livekit-gateway.js';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};

const config: ApiConfig = {
  livekitUrl: required('LIVEKIT_URL'),
  apiKey: required('LIVEKIT_API_KEY'),
  apiSecret: required('LIVEKIT_API_SECRET'),
  tokenTtlSeconds: Number(process.env.LIVEKIT_TOKEN_TTL_SECONDS ?? 900),
  rateLimit: { max: Number(process.env.RATE_LIMIT_MAX ?? 30), timeWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000) }
};

const app = createApp({ config, livekit: new LiveKitServerGateway(config) });
const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: '0.0.0.0' });
