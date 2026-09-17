import { createApp } from './app.js';
import { loadServerConfig } from './config.js';
import { LiveKitServerGateway } from './livekit-gateway.js';

const { apiConfig, port } = loadServerConfig(process.env);
const app = createApp({ config: apiConfig, livekit: new LiveKitServerGateway(apiConfig) });
await app.listen({ port, host: '0.0.0.0' });
