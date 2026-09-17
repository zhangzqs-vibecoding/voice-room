# Voice Room

面向 2–10 人的网页实时语音聊天室，支持昵称和头像入场、麦克风选择、实时发声状态，以及语音/乐器原声两种音频模式。

音频传输使用自建 LiveKit SFU；Node.js 服务只创建房间并签发短期入房凭据，不保存或转发音频。

详细设计见 [设计说明](docs/superpowers/specs/2026-09-17-voice-room-design.md)，实施拆分见 [实施计划](docs/superpowers/plans/2026-09-17-voice-room.md)。

## 本地 API

需要 Node.js 22 与 pnpm。复制 `.env.example` 为 `.env`，将 `LIVEKIT_API_KEY` 和
`LIVEKIT_API_SECRET` 替换为本地 LiveKit 的凭据（不要提交 `.env`）。

```sh
pnpm install
pnpm --filter @voice-room/api dev
```

API 监听 `http://localhost:3000`，健康检查为 `GET /health`。创建房间和加入房间的接口
只在服务器端使用 LiveKit 密钥，浏览器响应只会得到短期入房 token。

运行验证：

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```
