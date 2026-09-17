# GHCR 镜像发布 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将公开仓库的 API 和 Web Docker 镜像安全发布到 GitHub Container Registry。

**Architecture:** 新增独立的发布工作流，不改变现有 CI。PR 构建但不推送；`main` 及 `v*` 标签使用 GitHub 自动令牌登录 GHCR，分别推送 API 和 Web 镜像，并生成可追溯标签。

**Tech Stack:** GitHub Actions、docker/build-push-action、docker/metadata-action、GHCR、Node.js 测试契约。

---

### Task 1: 发布工作流契约

**Files:**
- Create: `.github/workflows/publish-images.yml`
- Modify: `test/deployment.test.mjs`
- Test: `test/deployment.test.mjs`

- [ ] **Step 1: 写入失败的工作流契约测试**

在 `test/deployment.test.mjs` 添加：

```js
test('GHCR 发布工作流仅在 main 与版本标签推送镜像', async () => {
  const workflow = await text('.github/workflows/publish-images.yml');
  for (const value of ['push:', 'branches: [main]', "tags: ['v*']", 'packages: write', 'docker/login-action@v3', 'docker/build-push-action@v6', 'deploy/Dockerfile.api', 'deploy/Dockerfile.web']) {
    assert.match(workflow, new RegExp(value.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')));
  }
  assert.match(workflow, /push: \$\{\{ github\.event_name == 'push' \}\}/);
});
```

- [ ] **Step 2: 运行测试，确认失败**

运行：`node --test test/deployment.test.mjs`

预期：失败，提示无法读取 `publish-images.yml`。

- [ ] **Step 3: 添加最小发布工作流**

创建 `.github/workflows/publish-images.yml`，包含：

```yaml
name: Publish images
on:
  push:
    branches: [main]
    tags: ['v*']
  pull_request:
permissions:
  contents: read
  packages: write
jobs:
  images:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        include:
          - name: api
            dockerfile: deploy/Dockerfile.api
          - name: web
            dockerfile: deploy/Dockerfile.web
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        if: github.event_name == 'push'
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/${{ github.repository }}-${{ matrix.name }}
          tags: |
            type=raw,value=latest,enable={{is_default_branch}}
            type=sha,format=long
            type=ref,event=tag
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: ${{ matrix.dockerfile }}
          push: ${{ github.event_name == 'push' }}
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
```

- [ ] **Step 4: 运行测试，确认通过**

运行：`node --test test/deployment.test.mjs`

预期：所有部署契约测试通过。

- [ ] **Step 5: 提交**

```bash
git add .github/workflows/publish-images.yml test/deployment.test.mjs
git commit -m "ci: publish API and web images to GHCR"
```

### Task 2: 公开仓库与端到端验证

**Files:**
- Modify: GitHub repository visibility（外部仓库设置）
- Test: GitHub Actions workflow 与 GHCR package metadata

- [ ] **Step 1: 切换仓库可见性**

运行：`gh repo edit zhangzqs-vibecoding/voice-room --visibility public --accept-visibility-change-consequences`

预期：`gh repo view --json visibility` 返回 `PUBLIC`。

- [ ] **Step 2: 推送分支并创建 PR**

运行：`git push -u origin feature/ghcr-publish`，再通过 `gh pr create` 创建到 `main` 的 PR。

预期：PR 工作流构建 API、Web 但不写入 GHCR。

- [ ] **Step 3: 审查、合并并验证发布**

在独立审查批准与 PR CI 成功后 squash 合并。查询 main 对应发布运行，确认 API 和 Web 两个矩阵任务成功，并使用：

```bash
gh api /orgs/zhangzqs-vibecoding/packages/container/voice-room-api
gh api /orgs/zhangzqs-vibecoding/packages/container/voice-room-web
```

预期：两个 package 存在，且具备 `latest` 与 main commit SHA 标签。
