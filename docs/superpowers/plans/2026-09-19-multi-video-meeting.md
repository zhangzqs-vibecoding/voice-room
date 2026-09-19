# 多人视频会议 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 在现有 LiveKit 语音房间上增加最多 50 人的腾讯会议式视频会议、主持人链接、会议控制、聊天/举手、屏幕共享和浏览器本地合成录制。

**Architecture:** API 继续负责短期 LiveKit Token 和房间生命周期；创建房间时生成主持人凭证和普通参会凭证。Web 端以 LiveKit room 为媒体总线，将成员状态、视频布局、控制事件和本地录制拆成独立模块。生产部署继续使用现有 GHCR API/Web 镜像和 LiveKit SFU。

**Tech Stack:** TypeScript, Fastify, React, livekit-client, Vitest, React Testing Library, MediaRecorder, Canvas, Web Audio, pnpm, Docker Compose。

---

### Task 1: API 房间配置与主持人凭证

**Files:**
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/livekit-gateway.ts`
- Modify: `apps/api/src/config.ts`
- Test: `apps/api/test/app.test.ts`

- [ ] 添加 `maxParticipants` 解析，拒绝小于 2、大于 50 或非整数。
- [ ] 创建房间时生成随机主持人 secret 与 participant secret，响应返回两个链接所需的凭证。
- [ ] 将主持人身份放入 Token metadata/grants，普通 Token 不包含主持权限。
- [ ] 增加主持人控制所需的 Gateway 方法：移除成员、静音/取消发布、结束房间、锁定房间。
- [ ] 先写失败测试，再实现；覆盖边界值、普通/主持 Token 权限和错误码。
- [ ] 运行 `pnpm --filter @voice-room/api test`。
- [ ] 提交 `feat(api): add configurable meeting hosts and limits`。

### Task 2: Web LiveKit 视频会话层

**Files:**
- Modify: `apps/web/src/livekit-session.ts`
- Create: `apps/web/src/meeting-session.ts`
- Test: `apps/web/test/audio-session.test.ts`
- Create: `apps/web/test/meeting-session.test.ts`

- [ ] 将现有音频连接扩展为麦克风、摄像头和屏幕共享的发布/停止接口。
- [ ] 监听远端视频轨道、成员加入离开、发言人变化、数据消息和重连状态。
- [ ] 提供设备枚举与切换接口，摄像头/麦克风权限失败时返回可展示错误。
- [ ] 使用 720p 优先的视频捕获约束，并允许 LiveKit 自适应降级。
- [ ] 用 fake room/track 写单元测试覆盖轨道生命周期和屏幕共享结束。
- [ ] 运行 `pnpm --filter @voice-room/web test`。
- [ ] 提交 `feat(web): add multi-track meeting session`。

### Task 3: 视频布局、控制栏和会议交互

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/domain.ts`
- Modify: `apps/web/src/styles.css`
- Create: `apps/web/src/meeting-layout.tsx`
- Create: `apps/web/src/meeting-controls.tsx`
- Test: `apps/web/test/app.test.tsx`
- Create: `apps/web/test/meeting-layout.test.tsx`

- [ ] 将入会页改为会议页，支持主持人链接/参会链接、昵称和身份。
- [ ] 实现发言人主画面 + 其他成员网格，50 人时可滚动/分页。
- [ ] 实现静音、摄像头、屏幕共享、聊天、举手、设备选择和录制按钮。
- [ ] 展示成员发言状态、连接状态、摄像头关闭头像和主持人标记。
- [ ] 仅向主持人显示主持控制，普通参会者显示禁用/隐藏状态。
- [ ] 用 React Testing Library 覆盖布局、控制事件和无权限错误提示。
- [ ] 运行 `pnpm --filter @voice-room/web test`、`pnpm --filter @voice-room/web typecheck`。
- [ ] 提交 `feat(web): add meeting layout and controls`。

### Task 4: 聊天、举手和主持人操作

**Files:**
- Modify: `apps/web/src/meeting-session.ts`
- Modify: `apps/web/src/meeting-controls.tsx`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/test/app.test.ts`
- Test: `apps/web/test/meeting-session.test.ts`

- [ ] 通过 LiveKit data packets 实现聊天和举手事件，限制消息长度并显示发送者身份。
- [ ] 将主持人控制映射到 API/LiveKit 权限操作，处理目标成员离开后的幂等错误。
- [ ] 实现锁定会议后拒绝新参会者、结束会议后广播结束状态。
- [ ] 测试普通 Token 被拒绝、主持操作成功、聊天和举手状态同步。
- [ ] 运行 API/Web 全量测试。
- [ ] 提交 `feat: add meeting collaboration and host controls`。

### Task 5: 浏览器本地合成录制

**Files:**
- Create: `apps/web/src/local-recorder.ts`
- Modify: `apps/web/src/meeting-controls.tsx`
- Test: `apps/web/test/local-recorder.test.ts`

- [ ] 将当前布局的视频元素绘制到 720p Canvas，主讲人和网格成员按布局合成。
- [ ] 使用 Web Audio 混合本地和远端音轨，避免录制静音视频。
- [ ] 选择 `video/webm;codecs=vp9,opus`，不支持时依次回退到浏览器可用 MIME。
- [ ] 停止时生成 Blob、下载文件并释放 AudioContext、MediaStream 和 URL。
- [ ] 处理无录制权限/编码器不支持，不影响会议通话。
- [ ] 使用 mock MediaRecorder/Canvas 测试 start/stop、fallback 和 cleanup。
- [ ] 运行 Web 测试、typecheck、lint。
- [ ] 提交 `feat(web): add local composite meeting recording`。

### Task 6: 端到端集成、部署和文档

**Files:**
- Modify: `test/deployment.test.mjs`
- Modify: `deploy/production/docker-compose.yml`
- Modify: `deploy/production/.env.example`
- Modify: `README.md`
- Create: `apps/web/e2e/meeting.spec.ts`

- [ ] 更新部署测试，验证 API/Web 镜像、视频所需端口和 50 人配置。
- [ ] 确认生产环境公开 LiveKit WebSocket、TURN UDP/TCP 和 SPA 路由。
- [ ] 添加 Playwright 流程：创建会议、打开参会链接、验证视频控制和主持人入口。
- [ ] 更新使用文档、浏览器权限、录制下载和主持人链接说明。
- [ ] 运行 `pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm build`、Compose config。
- [ ] 提交 `test: verify multi-video deployment`。

### Task 7: 集成审查、合并和部署

- [ ] 检查每个任务提交的 diff，运行 spec review 和 code quality review。
- [ ] 合并所有任务分支到 `feature/prod-vps`，解决冲突并运行完整验证。
- [ ] 构建并推送 GHCR 镜像，确认生产 Compose 使用新 SHA。
- [ ] 通过 `ssh vps-jp` 更新 `.env`/Compose，滚动重启服务。
- [ ] 验证容器健康、HTTPS、LiveKit WebSocket、TURN 端口和浏览器会议流程。
- [ ] 保留部署日志和回滚用的上一镜像 SHA。
