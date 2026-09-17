# Voice Room

面向 2–10 人的网页实时语音聊天室，支持昵称和头像入场、麦克风选择、实时发声状态，以及语音/乐器原声两种音频模式。

音频传输使用自建 LiveKit SFU；Node.js 服务只创建房间并签发短期入房凭据，不保存或转发音频。

详细设计见 [设计说明](docs/superpowers/specs/2026-09-17-voice-room-design.md)，实施拆分见 [实施计划](docs/superpowers/plans/2026-09-17-voice-room.md)。
