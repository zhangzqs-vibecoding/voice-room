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

API 在加入审核时检查 5 分钟生命周期：到期且 SFU 房间已不存在时才失效；只要 LiveKit
仍保留该房间（包括最后离开后的 departure timeout），便在审核点续期 5 分钟。服务不
声称实时侦测未来的离开事件。API 会在签发 token 时最多接纳 10 人，LiveKit 的
`maxParticipants` 仍是实际加入房间时的最终容量限制。

运行验证：

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```
