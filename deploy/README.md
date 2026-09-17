# 自建部署

本目录提供面向开发和单节点生产准备的配置。音频媒体只经 LiveKit SFU；API 持有
LiveKit 凭据、创建最多 10 人的房间并签发短期 token。Redis 不保存为对外服务，也不
承载录音或用户数据。

## 本地开发

需要 Docker Compose、Node.js 22 和 pnpm。复制环境模板后，为本机生成一组高熵 API
凭据；不要使用示例值，也不要提交 `.env`。

```sh
cp .env.example .env
# 编辑 .env：设置 LIVEKIT_API_KEY 与 LIVEKIT_API_SECRET
docker compose --env-file .env -f deploy/docker-compose.yml up --build
```

然后访问 `http://localhost:5173`；浏览器到 API 的 `/api` 请求由本地 Caddy 容器转发，
API 以容器内的 `ws://livekit:7880` 访问 SFU。调试客户端使用
`ws://localhost:7880`。Redis 没有主机端口映射。停止时使用：

```sh
docker compose --env-file .env -f deploy/docker-compose.yml down
```

本地配置暴露 7880（仅开发信令）、7881/TCP 与 50000–50100/UDP；TURN 被禁用，因为
本机无可信 TLS 证书。当前 Web 只提供入场与房间界面；合并音频会话实现前，不应把本地
页面视作双浏览器通话验收。

## 生产网络与 TLS

生产不要直接复用本地 Compose 暴露的 7880。为 `app.example.com` 与
`turn.example.com` 准备 DNS A/AAAA 记录，均指向 LiveKit 节点公网 IP。浏览器连接必须
使用 `https://`/`wss://app.example.com`；LiveKit API/信令 7880 放在 HTTPS 反向代理后，
业务 API 3000 和 Redis 不对公网开放。

按 LiveKit 官方 VM 生成器生成匹配域名的 `caddy.yaml`、`docker-compose.yaml` 和
`livekit.yaml`，然后在专用 Linux VM 上部署：

```sh
docker pull livekit/generate
docker run --rm -it -v "$PWD:/output" livekit/generate
```

生成器使用 Caddy 申请可信证书；不要使用自签名证书。单 IP 的 443/TCP 不能同时由普通
HTTP Caddy 与原始 TURN/TLS 各自独占。需要 Caddy Layer 4/SNI 路由（或独立四层负载均衡）
按 TLS SNI 把 `app.example.com` 交给 HTTPS，`turn.example.com` 交给 TURN；Layer 7 的
`reverse_proxy` 不能代替它。没有 L4/SNI 能力时，为 TURN/TLS 使用单独 IP 或改用可公开
访问的 5349/TCP，并让客户端和防火墙策略相应匹配。

防火墙最小开放面（官方默认生产范围）如下；实际范围必须与生成的 LiveKit 配置一致：

| 端口 | 协议 | 用途 |
| --- | --- | --- |
| 80 | TCP | 首次签发/续期 TLS 证书 |
| 443 | TCP | HTTPS、WSS 与经 L4/SNI 路由的 TURN/TLS |
| 7881 | TCP | ICE/TCP 回退，必须直达 LiveKit |
| 3478 | UDP | TURN/UDP |
| 50000–60000 | UDP | WebRTC 媒体 |

生产 `livekit.yaml` 应使用 Redis、`rtc.use_external_ip: true`、`rtc.tcp_port: 7881` 和
`rtc.port_range_start/end: 50000/60000`。启用 TURN 时设置 `turn.enabled: true`、匹配
可信证书的 `turn.domain`，并将非 L4 终止的 `turn.tls_port` 设为 443。将
`LIVEKIT_API_KEY`、`LIVEKIT_API_SECRET`、TURN 域名和证书交给宿主机的受控密钥管理；
它们不能进入 Git、镜像层或 CI 日志。

## 验证与排障

提交前运行：

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm build
docker compose --env-file .env -f deploy/docker-compose.yml config
```

真实部署还需要在两个独立网络的浏览器中验收 UDP、ICE/TCP 和 TURN/TLS 回退；用声卡或
乐器执行实际音频模式验收，并检查 LiveKit/Caddy 日志与防火墙安全组。Docker 化 LiveKit
在生产中应使用 host networking 或等价的直达端口映射，以避免 NAT 破坏候选地址。

官方参考：[部署](https://docs.livekit.io/transport/self-hosting/deployment/)、
[VM 生成器](https://docs.livekit.io/transport/self-hosting/vm/)、
[端口与防火墙](https://docs.livekit.io/transport/self-hosting/ports-firewall/)。
