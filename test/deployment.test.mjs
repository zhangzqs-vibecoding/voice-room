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
  assert.doesNotMatch(compose, /^\s*-\s*["']?6379:6379/m);
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
  for (const command of ['pnpm install --frozen-lockfile', 'pnpm test', 'pnpm typecheck', 'pnpm lint', 'pnpm build', 'docker compose --env-file .env.example -f deploy/docker-compose.yml config']) {
    assert.match(workflow, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
