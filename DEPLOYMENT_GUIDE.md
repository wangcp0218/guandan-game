# OOWSP 修改与部署指南

本文档供共同维护者使用，说明如何修改代码、同步 GitHub 与阿里云效两个仓库，并部署到当前生产服务器。

> 重要：部署会重启服务，所有保存在内存中的房间和正在进行的牌局都会消失。发布前必须通知在线用户。账号密码、SSH 私钥和大模型 API Key 不得提交到 Git。

## 1. 当前环境

| 项目 | 当前配置 |
|---|---|
| GitHub | `https://github.com/wangcp0218/guandan-game.git` |
| 阿里云效 | `git@codeup.aliyun.com:fueternal/fes_guandan.git` |
| 部署服务器 | `fes@192.168.150.34` |
| 程序目录 | `/home/fes/oowsp` |
| systemd 服务 | `oowsp` |
| 服务端口 | `3000` |
| 对外入口 | `http://192.168.150.34/` |
| Nginx 配置 | `/etc/nginx/sites-available/oowsp` |
| systemd 配置 | `/etc/systemd/system/oowsp.service` |

生产服务器已验证使用 Node.js `v24.18.0`、npm `11.16.0`、Nginx `1.26.3`。新环境建议使用 Node.js 20 或更高版本。

项目是 npm workspaces monorepo：

- `client/`：React + Vite，产物位于 `client/dist/`
- `server/`：Express + Socket.IO，入口为 `server/dist/server/src/index.js`
- `shared/`：前后端共享类型

修改 `shared/types.ts` 时，还要同步修改 `client/src/sharedTypes.ts`。

## 2. 获取访问权限

同事需要分别取得三类权限：

1. GitHub 仓库写权限。
2. 阿里云效仓库写权限，并在云效个人设置中添加自己的 SSH 公钥。
3. 生产服务器 `fes@192.168.150.34` 的 SSH 权限，以及执行 `sudo systemctl restart oowsp` 的权限。

不要互相传递私钥。每个人应生成自己的密钥，再由管理员添加公钥。

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_codeup -C "姓名-codeup"
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_oowsp -C "姓名-oowsp-deploy"
```

Codeup 密钥可以写入 `~/.ssh/config`：

```sshconfig
Host codeup.aliyun.com
  HostName codeup.aliyun.com
  User git
  IdentityFile ~/.ssh/id_ed25519_codeup
  IdentitiesOnly yes
```

首次连接时应核对云效官方公布的主机指纹。当前已验证的 RSA 指纹为：

```text
SHA256:yEGmgQNVrc3QAvDvoBrTCF2s07KwmmQ+AbWi9vSt/fE
```

测试连接：

```bash
ssh -T git@codeup.aliyun.com
ssh -i ~/.ssh/id_ed25519_oowsp fes@192.168.150.34
```

GitHub 当前使用 HTTPS，可使用系统凭据管理器、Personal Access Token 或 `gh auth login` 登录。

## 3. 克隆并配置两个仓库

```bash
git clone https://github.com/wangcp0218/guandan-game.git guandan
cd guandan
git remote add codeup git@codeup.aliyun.com:fueternal/fes_guandan.git
git remote -v
```

首次工作前确认两个 `main` 指向同一提交：

```bash
git fetch origin main
git fetch codeup main
git rev-parse origin/main
git rev-parse codeup/main
```

若提交不同，不要强制推送，先确认哪个仓库包含最新修改并合并差异。

## 4. 本地安装、开发和验证

```bash
npm install
npm run dev -w server
```

另开终端运行客户端：

```bash
npm run dev -w client
```

本地入口通常为 `http://localhost:5173/`，Vite 会把 Socket.IO 请求代理到服务端 `3000` 端口。

提交前必须按顺序构建服务端和客户端：

```bash
npm run build -w server
npm run build -w client
git diff --check
git status --short
```

不要在 macOS 上构建后直接把 `node_modules` 传到 Linux；生产服务器会按自身架构安装依赖并重新构建。

## 5. 推荐的协作流程

从最新 `main` 建立功能分支：

```bash
git switch main
git pull --ff-only origin main
git switch -c feature/简短功能名
```

完成修改和验证后提交：

```bash
git add <本次修改的文件>
git commit -m "fix: 简要说明"
git push -u origin HEAD
```

建议通过 GitHub Pull Request 审核并合并。准备部署时回到 `main`，确认工作区干净：

```bash
git switch main
git pull --ff-only origin main
git status --short --branch
```

再把相同提交同步至阿里云效：

```bash
git push codeup main
git rev-parse HEAD
git ls-remote origin refs/heads/main
git ls-remote codeup refs/heads/main
```

三个哈希必须一致。不要使用 `git push --force` 覆盖其他同事的修改。

## 6. 大模型环境变量

密钥只保存在服务器，不放入源码包。建议创建仅 `fes` 可读的 `/home/fes/oowsp/.env.production`：

```bash
PORT=3000
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_API_KEY=replace_with_deepseek_api_key
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_TIMEOUT_MS=8000
LOCAL_LLM_BASE_URL=http://192.168.150.51:3000/v1
LOCAL_LLM_API_KEY=replace_with_local_model_api_key
LOCAL_LLM_TIMEOUT_MS=20000
```

设置权限：

```bash
chmod 600 /home/fes/oowsp/.env.production
```

`.env` 和 `.env.*` 必须保持在 `.gitignore` 中。日志、截图和聊天消息中也不要粘贴真实密钥。

## 7. 首次配置 systemd

现网已经配置好，本节仅用于重建服务器。`/etc/systemd/system/oowsp.service` 可采用：

```ini
[Unit]
Description=OOWSP Guandan Game Server
After=network.target

[Service]
Type=simple
User=fes
WorkingDirectory=/home/fes/oowsp
EnvironmentFile=/home/fes/oowsp/.env.production
ExecStart=/usr/bin/node /home/fes/oowsp/server/dist/server/src/index.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

启用服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now oowsp
systemctl status oowsp --no-pager
```

## 8. 首次配置 Nginx

仓库中的 `deploy/nginx.conf` 是当前站点模板：

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/oowsp
sudo ln -sfn /etc/nginx/sites-available/oowsp /etc/nginx/sites-enabled/oowsp
sudo /usr/sbin/nginx -t
sudo systemctl reload nginx
```

Nginx 提供 `client/dist` 静态文件，并将 `/socket.io/` 转发到 `127.0.0.1:3000`。

## 9. 日常一键部署

确认当前位于已经提交、工作区干净的 `main` 后执行：

```bash
SSH_KEY_PATH=~/.ssh/id_ed25519_oowsp ./deploy/deploy.sh
```

脚本会自动执行：

1. 检查工作区是否干净。
2. 本地依次构建 server、client。
3. 打包源码，但排除 `.git`、`node_modules`、`dist`、环境变量和 `data`。
4. 上传到 `/home/fes/oowsp-src.tar.gz`。
5. 在 Linux 服务器安装依赖并重新构建。
6. 重启 `oowsp` systemd 服务。
7. 检查服务状态和 HTTP 状态码。

如果密钥已经加载到 `ssh-agent`，可直接运行：

```bash
./deploy/deploy.sh
```

`deploy/deploy.sh` 不保存密码，不使用 PM2，也不会上传或覆盖生产 `data/`。

## 10. 手工部署命令

一键脚本不可用时，可执行以下流程：

```bash
npm run build -w server
npm run build -w client

COPYFILE_DISABLE=1 tar czf /tmp/oowsp-src.tar.gz \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='.git' \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='data' \
  .

scp -i ~/.ssh/id_ed25519_oowsp \
  /tmp/oowsp-src.tar.gz \
  fes@192.168.150.34:/home/fes/oowsp-src.tar.gz

ssh -i ~/.ssh/id_ed25519_oowsp fes@192.168.150.34
```

登录服务器后：

```bash
set -e
cd /home/fes/oowsp
tar xzf /home/fes/oowsp-src.tar.gz
rm /home/fes/oowsp-src.tar.gz
npm install
npm run build -w server
npm run build -w client
sudo systemctl restart oowsp
systemctl is-active oowsp
curl -fsS -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1/
```

预期输出包括：

```text
active
HTTP 200
```

## 11. 发布后检查

```bash
systemctl status oowsp --no-pager
journalctl -u oowsp -n 100 --no-pager
curl -I http://127.0.0.1/
```

然后在浏览器访问 `http://192.168.150.34/`，至少验证：

- 登录和大厅正常打开。
- 能创建房间并自动补齐 AI。
- 四个座位能正常出牌、过牌和轮转。
- 聊天与观察者模式正常。
- DeepSeek 与 local 模型列表能正常加载。

若页面仍显示旧版本，使用 `Cmd+Shift+R` 或 `Ctrl+Shift+R` 强制刷新。

## 12. 数据保护与回滚

用户和战绩数据位于：

```text
/home/fes/oowsp/data/users.json
/home/fes/oowsp/data/records.json
```

源码部署包排除了 `data/`，正常部署不会覆盖这些文件。重大改动前仍建议备份：

```bash
ssh fes@192.168.150.34 \
  'cd /home/fes/oowsp && tar czf /home/fes/oowsp-data-backup.tar.gz data'
```

推荐用 `git revert <问题提交>` 创建回滚提交，再同步两个仓库并重新部署。不要在共享分支上使用 `git reset --hard` 或强制推送。

## 13. 常见故障

### 服务启动失败

```bash
journalctl -u oowsp -n 200 --no-pager
systemctl status oowsp --no-pager
```

确认 systemd 的 `WorkingDirectory` 是 `/home/fes/oowsp`，入口是 `server/dist/server/src/index.js`。

### 3000 端口被占用

```bash
ss -ltnp | grep ':3000'
pm2 list
```

旧服务器可能残留 PM2 进程。确认它确实属于本项目后再停止，避免与 systemd 同时管理同一端口。

### Nginx 返回 502

```bash
systemctl is-active oowsp
sudo /usr/sbin/nginx -t
journalctl -u nginx -n 100 --no-pager
```

### 模型列表加载失败

检查对应 API Key、Base URL、网络连通性和 `/models` 接口。不要把密钥打印到终端共享记录中。

### 两个 Git 仓库不同步

```bash
git fetch origin main
git fetch codeup main
git log --oneline --left-right origin/main...codeup/main
```

先合并缺失提交，再正常推送；不要直接强制覆盖。
