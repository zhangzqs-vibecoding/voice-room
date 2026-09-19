# 自建部署

本目录提供面向开发和单节点生产的配置。音视频媒体只经 LiveKit SFU；API 持有
LiveKit 凭据、创建最多 50 人的房间并签发短期 token。Redis 不保存为对外服务，也不
承载录音或用户数据。会议采用浏览器本地录制，不上传服务器。

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
`ws://localhost:7880`，它由 Compose 的 `LIVEKIT_PUBLIC_URL` 返回；绝不能把仅容器内部
可达的 `LIVEKIT_URL=ws://livekit:7880` 返回给浏览器。Redis 没有主机端口映射。停止时使用：

```sh
docker compose --env-file .env -f deploy/docker-compose.yml down
```

本地配置暴露 7880（仅开发信令）、7881/TCP 与 50000–50100/UDP；TURN 被禁用，因为
本机无可信 TLS 证书。容器健康检查会依次确认 LiveKit HTTP 端点、API `/health` 与 Web
静态入口；这只证明服务可用，不取代实际媒体链路验收。

## 生产网络与 TLS

生产不要直接复用本地 Compose 暴露的 7880。为 `app.example.com` 与
`turn.example.com` 准备 DNS A/AAAA 记录，均指向 LiveKit 节点公网 IP。浏览器连接必须
使用 `https://`/`wss://app.example.com`；LiveKit API/信令 7880 放在 HTTPS 反向代理后，
业务 API 3000 和 Redis 不对公网开放。

生产 API 设置 `LIVEKIT_URL=ws://livekit:7880`（或私网 SFU 地址）供 RoomService 调用，
并单独设置 `LIVEKIT_PUBLIC_URL=wss://app.example.com` 供 join 响应返回给浏览器。两个值
都必须是 `ws://` 或 `wss://` URL；前者不得暴露给客户端。

生产 Compose 使用 GHCR 的不可变 SHA 镜像标签。部署前复制模板并填写本次 GitHub Actions
构建生成的完整 40 位提交标签，以及高熵 LiveKit 凭据：

```sh
cp deploy/production/.env.example deploy/production/.env
# 修改 VOICE_ROOM_IMAGE_TAG=sha-<40 位提交 SHA>
# 修改 LIVEKIT_API_KEY 和 LIVEKIT_API_SECRET
chmod 600 deploy/production/.env
docker compose --env-file deploy/production/.env -f deploy/production/docker-compose.yml config
```

不要把生产 `.env` 提交到 Git。创建会议时 API 接受 2–50 的 `maxParticipants`；浏览器
使用返回的主持人链接或参会链接加入。主持人权限由短期 LiveKit Token 校验，不能通过修改
前端参数获得。会议默认以 720p 发送视频，并支持摄像头、屏幕共享、文字聊天和举手；录制
使用浏览器本地录制，停止后下载合成的 WebM 文件。

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

当前单节点 Compose 示例为资源受限 VPS 使用的 `50000–50100/UDP`；如果调整
`deploy/production/livekit.yaml` 的范围，必须同步调整 Compose 端口映射和防火墙规则。

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

真实部署需要在两个独立网络的浏览器中创建并加入同一房间，确认双方可听见对方、成员
说话状态会变化、麦克风切换与静音正常。分别验收 UDP 优先链路、阻断 UDP 后的 ICE/TCP
回退、以及再受限网络下的 TURN/TLS 回退；随后用声卡或乐器在原声模式下确认持续弱音和
尾音不被截断。检查 LiveKit/Caddy 日志与防火墙安全组。Docker 化 LiveKit 在生产中应使用
host networking 或等价的直达端口映射，以避免 NAT 破坏候选地址。

官方参考：[部署](https://docs.livekit.io/transport/self-hosting/deployment/)、
[VM 生成器](https://docs.livekit.io/transport/self-hosting/vm/)、
[端口与防火墙](https://docs.livekit.io/transport/self-hosting/ports-firewall/)。
