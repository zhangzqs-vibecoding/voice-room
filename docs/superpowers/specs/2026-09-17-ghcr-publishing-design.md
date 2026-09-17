# GHCR 镜像发布设计

## 目标

将仓库公开，并在 GitHub Actions 中把已审查的 `main` 与版本标签构建为可部署的 GHCR 镜像。

## 发布边界

- API 镜像：`ghcr.io/zhangzqs-vibecoding/voice-room-api`，使用 `deploy/Dockerfile.api`。
- Web 镜像：`ghcr.io/zhangzqs-vibecoding/voice-room-web`，使用 `deploy/Dockerfile.web`。
- `main` 推送发布 `latest` 与完整 commit SHA 标签；`v*` 标签再发布语义版本标签。
- Pull request 只构建两个镜像验证 Dockerfile，不登录 GHCR、不推送镜像。
- 现有 `ci.yml` 继续负责测试、类型检查、Lint、应用构建与 Compose 构建。

## 安全

- 工作流权限最小化：`contents: read` 与 `packages: write`。
- 使用 GitHub 自动提供的 `GITHUB_TOKEN` 登录 `ghcr.io`，不增加或打印个人令牌。
- Docker 构建上下文遵守现有 Dockerfile；`.env` 不进入仓库或镜像。

## 验收

- 仓库可公开访问。
- `main` 推送成功后，GHCR 中可拉取 API 和 Web 的 `latest` 与 SHA 标签。
- 版本标签推送后，可拉取对应版本标签。
- PR 的工作流日志中两个镜像均构建成功，且未出现 push 步骤。
