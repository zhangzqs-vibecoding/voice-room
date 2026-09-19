# Voice Room

面向 2–50 人的网页实时语音/视频会议，支持昵称和身份入场、麦克风/摄像头选择、实时发声状态、屏幕共享、文字聊天、举手和主持人控制。默认以 720p 发送视频，WebRTC 会根据网络状况自适应降级；语音和乐器原声模式仍然可用。

音视频传输使用自建 LiveKit SFU；Node.js 服务只创建房间并签发短期入房凭据，不保存或转发音视频。录制采用浏览器本地录制，使用当前会议布局合成画面和混合声音，停止后下载 WebM 文件，不上传服务器。

详细设计见 [多人视频会议设计](docs/superpowers/specs/2026-09-19-multi-video-meeting-design.md)，实施拆分见 [多人视频会议计划](docs/superpowers/plans/2026-09-19-multi-video-meeting.md)。

## 创建和加入会议

创建会议时选择 2–50 人的上限。API 返回独立的主持人链接和参会链接：主持人链接可恢复主持权限，参会链接可直接输入昵称/身份加入，不需要密码或审批。主持人可以静音成员、关闭成员摄像头、移出成员、锁定会议和结束会议。

浏览器需要允许麦克风和摄像头权限；拒绝权限时仍可仅观看，之后可以在设备设置中重试。屏幕共享由浏览器原生授权，停止共享后会自动恢复摄像头布局。录制按钮只在本地生成文件，会议结束或手动停止后请保存下载的 WebM 文件。

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
声称实时侦测未来的离开事件。API 仅在 JWT 同时签名时最多保留 10 个槽位，签名完成就
释放；LiveKit 的 `maxParticipants` 是实际在线人数的最终容量限制。

本地开发保持 `TRUSTED_PROXY_CIDRS` 为空。部署在 Caddy 等反向代理之后时，填写代理
实际来源的内部 IP 或 CIDR（例如 `172.18.0.0/16`）；仅这些代理的
`X-Forwarded-For` 会用于限流，避免客户端伪造转发地址。`ROOM_SWEEP_TIMEOUT_MS` 限制
缓存满时并行 SFU 清扫的总等待时间；超时且未腾出位置会返回 `room_cache_full`。
`LIVEKIT_REQUEST_TIMEOUT_MS` 限制创建房间和加入审核的上游 LiveKit 等待时间，必须为
`1000`ms 的正整数倍，以精确匹配 SDK 的秒级请求 deadline。

运行验证：

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```
