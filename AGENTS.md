# Voice Room 工程约定

- 使用 TypeScript；前端使用 React，业务后端使用 Fastify。
- 实时音频由 LiveKit SFU 处理；业务服务不得代理或存储音频。
- 所有凭据只通过环境变量注入，绝不提交 `.env`。
- 新行为遵循 TDD：先写失败测试，再写最小实现。
- 每个 PR 合并前须运行受影响的 typecheck、lint、unit tests 和 build。
- 首版只实现实时音频；不实现账号、录音、消息、视频或远程同步合奏。
