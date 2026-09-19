import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const text = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('本地 Compose 以环境变量启动 Redis、LiveKit 和 API，且不发布 Redis', async () => {
  const compose = await text('deploy/docker-compose.yml');
  assert.match(compose, /^\s*redis:/m);
  assert.match(compose, /^\s*livekit:/m);
  assert.match(compose, /^\s*api:/m);
  assert.match(compose, /\$\{LIVEKIT_API_KEY:\?/);
  assert.match(compose, /\$\{LIVEKIT_API_SECRET:\?/);
  assert.match(compose, /LIVEKIT_URL: ws:\/\/livekit:7880/);
  assert.match(compose, /LIVEKIT_PUBLIC_URL: ws:\/\/localhost:7880/);
  assert.match(compose, /condition: service_healthy/);
  assert.match(compose, /wget -qO- http:\/\/localhost:7880\//);
  assert.match(compose, /fetch\('http:\/\/127\.0\.0\.1:3000\/health'\)/);
  assert.doesNotMatch(compose, /^\s*-\s*["']?6379:6379/m);
});

test('本地 Caddy 在 SPA 回退前将 API 请求反代给业务服务', async () => {
  const caddy = await text('deploy/Caddyfile.local');
  assert.match(caddy, /route\s*\{/);
  assert.ok(caddy.indexOf('handle /api/*') < caddy.indexOf('try_files'), 'API 路由必须先于 SPA 回退');
});

test('LiveKit 配置包含开发 Redis、ICE 回退和 TURN 端口，密钥由 CLI 注入', async () => {
  const config = await text('deploy/livekit.yaml');
  assert.match(config, /address: redis:6379/);
  assert.match(config, /tcp_port: 7881/);
  assert.match(config, /port_range_start: 50000/);
  assert.match(config, /port_range_end: 50100/);
  assert.match(config, /enabled: false/);
  assert.doesNotMatch(config, /^keys:/m);
});

test('CI 验证安装、测试、类型检查、lint、构建和部署配置', async () => {
  const workflow = await text('.github/workflows/ci.yml');
  assert.ok(workflow.indexOf('pnpm/action-setup@v4') < workflow.indexOf('actions/setup-node@v4'), 'pnpm 必须先于 setup-node 配置，供依赖缓存发现可执行文件');
  for (const command of ['pnpm install --frozen-lockfile', 'pnpm test', 'pnpm typecheck', 'pnpm lint', 'pnpm build', 'docker compose --env-file .env.example -f deploy/docker-compose.yml config', 'docker compose --env-file .env.example -f deploy/docker-compose.yml build']) {
    assert.match(workflow, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('API 镜像以 pnpm 10 兼容模式部署生产依赖', async () => {
  const dockerfile = await text('deploy/Dockerfile.api');
  assert.match(dockerfile, /pnpm --filter @voice-room\/api --prod deploy --legacy \/app/);
});

test('GHCR 发布工作流仅在 main 与版本标签推送镜像', async () => {
  const workflow = await text('.github/workflows/publish-images.yml');
  for (const value of ['push:', 'branches: [main]', "tags: ['v*']", 'packages: write', 'docker/login-action@v3', 'docker/build-push-action@v6', 'deploy/Dockerfile.api', 'deploy/Dockerfile.web']) {
    assert.match(workflow, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(workflow, /build:\n\s+if: github\.event_name == 'pull_request'\n\s+permissions:\n\s+contents: read/);
  assert.match(workflow, /publish:\n\s+if: github\.event_name == 'push'\n\s+permissions:\n\s+contents: read\n\s+packages: write/);
  assert.match(workflow, /push: true/);
});

test('生产编排以公开镜像、TLS 分流与受限网络暴露部署 LiveKit', async () => {
  const [compose, envExample, livekit, caddy, dockerfile] = await Promise.all([
    text('deploy/production/docker-compose.yml'),
    text('deploy/production/.env.example'),
    text('deploy/production/livekit.yaml'),
    text('deploy/production/Caddyfile'),
    text('deploy/production/Dockerfile.edge'),
  ]);

  for (const value of [
    'ghcr.io/zhangzqs-vibecoding/voice-room-api:${VOICE_ROOM_IMAGE_TAG:?',
    'ghcr.io/zhangzqs-vibecoding/voice-room-web:${VOICE_ROOM_IMAGE_TAG:?',
    'redis:7.4-alpine',
    '443:443/tcp',
    '443:443/udp',
    '3478:3478/udp',
    '7881:7881/tcp',
    '50000-50100:50000-50100/udp',
    'LIVEKIT_PUBLIC_URL: wss://livekit.vps-jp.zhangzqs.cn',
    'TRUSTED_PROXY_CIDRS: 172.29.0.0/24',
  ]) {
    assert.match(compose, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(compose, /3000:3000|7880:7880|6379:6379/);
  for (const value of [
    'use_external_ip: true',
    'tcp_port: 7881',
    'port_range_start: 50000',
    'port_range_end: 50100',
    'enabled: true',
    'udp_port: 443',
    'tls_port: 443',
    'external_tls: true',
  ]) {
    assert.match(livekit, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  for (const domain of ['vps-jp.zhangzqs.cn', 'livekit.vps-jp.zhangzqs.cn', 'turn.vps-jp.zhangzqs.cn']) {
    assert.match(caddy, new RegExp(domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(caddy, /proxy livekit:443/);
  assert.match(dockerfile, /github\.com\/mholt\/caddy-l4/);
  assert.match(envExample, /^VOICE_ROOM_IMAGE_TAG=sha-[a-f0-9]{40}$/m);
});

test('生产文档说明 50 人视频会议、主持链接和浏览器本地录制', async () => {
  const [readme, deployReadme] = await Promise.all([text('README.md'), text('deploy/README.md')]);
  for (const document of [readme, deployReadme]) {
    for (const phrase of ['50 人', '720p', '主持人链接', '参会链接', '屏幕共享', '本地录制']) {
      assert.match(document, new RegExp(phrase));
    }
  }
});
