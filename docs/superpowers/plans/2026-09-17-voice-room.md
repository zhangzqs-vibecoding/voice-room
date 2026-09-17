# Voice Room Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付可自建、可测试的实时网页语音聊天室。

**Architecture:** pnpm workspace 包含 React/Vite Web 应用与 Fastify API。LiveKit 在 Docker Compose 中作为外部 SFU；API 创建受限临时房间并签发 JWT，Web 直接以 WebRTC 连接 SFU。

**Tech Stack:** Node.js 22、pnpm、TypeScript、React、Vite、Fastify、LiveKit JS/Server SDK、Vitest、Playwright、Docker Compose。

---

### Task 1: 工作区、API 与房间凭据

**Files:** 创建根 workspace 配置、`apps/api`、API 单元测试、环境模板。

- [ ] 先写 API 测试，覆盖房间 ID 格式、创建房间、加入 token 权限、错误输入、满员和失效房间。
- [ ] 实现 Fastify 健康检查、创建/加入接口、输入校验、基础内存限流、LiveKit RoomService adapter 与 token 签发。
- [ ] 创建房间时在 SFU 设置 10 人上限、5 分钟 empty timeout；只允许已由 API 创建的房间加入。
- [ ] 运行 API 测试、typecheck、lint、build，提交并创建 PR。

### Task 2: Web 入场与房间界面

**Files:** 创建 `apps/web`、组件单元测试与 Playwright 流程测试。

- [ ] 先写失败测试，覆盖创建邀请、昵称/头像校验、设备选择、仅收听进入、房间成员状态和移动布局关键控件。
- [ ] 实现深色录音室风格首页、入场页和房间页；使用 API client，不在浏览器暴露 LiveKit 密钥。
- [ ] 使用本地存储保存昵称、头像、设备和音质偏好；浏览器不支持或自动播放受限时给出提示。
- [ ] 运行 web unit、typecheck、lint、build 和 Playwright 测试，提交并创建 PR。

### Task 3: LiveKit 音频会话与说话状态

**Files:** 创建前端音频会话模块与其单元测试；补充房间控件集成测试。

- [ ] 先写失败测试，覆盖语音/乐器采集选项、切换后保留静音、仅收听、连接重试、离开时释放资源和音轨电平发声判定。
- [ ] 实现 LiveKit connect、token 获取、设备列举与切换、发布/取消发布、语音和乐器模式、远端音轨播放及 active-speaker/电平状态。
- [ ] 运行全部前端测试、typecheck、lint、build，提交并创建 PR。

### Task 4: 自建部署、端到端验证与 CI

**Files:** 创建 LiveKit/Caddy/Docker 配置、生产环境模板、GitHub Actions、部署与验收文档。

- [ ] 先写配置验证测试，覆盖开发 compose 服务、生产暴露端口、环境变量完整性和 CI 命令。
- [ ] 实现本地 LiveKit+Redis compose、生产 Compose/Caddy Layer4 说明、Docker 镜像、GitHub Actions 和运维排障文档。
- [ ] 运行全套测试、构建、compose 配置校验和浏览器端到端测试，提交并创建 PR。

## 合并门槛

- 每个任务由独立代理在独立分支完成、推送并创建 PR。
- 每个 PR 先经需求符合性审查，再经代码质量审查；所有 Critical/Important 问题修复后才可合并。
- 合并后在 `main` 运行完整 workspace 测试、构建和 Docker Compose 校验；真实双浏览器/乐器/受限网络验收记录在文档中。

## 默认假设

- 仓库为私有；项目名为 `voice-room`。
- 生产部署需用户提供 Linux VM 与三个 DNS 记录；仓库不含真实密钥、域名或证书。
- SFU 单节点足以服务首版 2–10 人房间。
