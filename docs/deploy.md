# 部署说明（远程服务器）

> 适用：一台 Linux 服务器（Ubuntu 22.04+/Debian 12 均可），有公网 IP 和一个域名。
> 结构：**Caddy**（HTTPS + 静态文件 + 反向代理）→ **Node 服务端**（`apps/server`，端口 8787）。前端是 `vite build` 出来的静态文件，与服务端同源。
> 麦克风（`getUserMedia`）只在 HTTPS 下可用，所以**必须有域名和证书**，不能用裸 IP + http 演示语音。

## 1. 服务器准备

```bash
# Node 22（与开发机一致：v22.23.x）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
sudo corepack enable && corepack prepare pnpm@11.0.9 --activate   # 仓库用 pnpm 11

# Caddy
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

建一个运行用户和目录：

```bash
sudo useradd -r -m -d /srv/mira -s /bin/bash mira
sudo -iu mira
git clone https://github.com/GongJiYang/mira-scene.git /srv/mira/app
cd /srv/mira/app
```

仓库约 100MB（含 Live2D 模型、预录语音），克隆需要一点时间。

## 2. 安装与构建

```bash
cd /srv/mira/app
pnpm install --frozen-lockfile
pnpm --filter @mira/client build        # 产物：apps/client/dist（含开发文档页，构建时打包 docs/*.md）
pnpm test && pnpm typecheck             # 可选：确认这台机器上也是绿的
```

## 3. 环境变量 `.env`

在 `/srv/mira/app/.env` 创建（**不要提交到仓库**，权限 `chmod 600 .env`）。只列变量名和作用，值从本机 `.env` 拷：

| 变量 | 必填 | 作用 |
|---|---|---|
| `PROVIDER_MODE` | 是 | `real` = 真实模型；`mock` = 不需要任何 Key 的演示模式（预录语音 + 脚本 LLM） |
| `LLM_PROVIDER` | 否 | 默认 `deepseek`。**服务器上用 deepseek**；`commandcode` 需要在服务器装 cmd，不建议 |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL` | real 时是 | LLM |
| `FISH_API_KEY` / `FISH_VOICE_ID` / `FISH_VOICE_ID_YUNA` / `FISH_TTS_MODEL` | real 时是 | 语音识别 + 合成（`s2.1-pro-free` 免费期到 2026-11-30） |
| `IMAGE_API_KEY` / `IMAGE_BASE_URL` / `IMAGE_MODEL` | 否 | 换背景生图；不配则生图走失败兜底 |
| `SESSION_TURN_LIMIT` | 否 | 每个会话最多轮数，默认 30（公开演示建议保留，防刷） |
| `DAILY_TURN_LIMIT` | 否 | 全站每日最多轮数，默认 300 |
| `PORT` | 否 | 服务端端口，默认 8787 |
| `OBS_ENABLED` | 否 | 观测页接口 `/obs/summary`，默认开；不想公开就设 `0` |
| `GENERATED_DIR` | 否 | 生成图片目录，默认 `var/generated/` |
| `FAULTS` | 否 | 故障注入，**线上留空** |

> 公开演示的建议：先用 `PROVIDER_MODE=mock` 上线验证页面、Live2D、语音播放都正常，再切 `real`。

> 访问者也可在页面设置里填自己的 Key（只在其会话内存中使用）；服务器不配真实 Key 时，默认 Mock。

## 4. 用 systemd 跑服务端

`/etc/systemd/system/mira.service`：

```ini
[Unit]
Description=mira-scene server
After=network.target

[Service]
User=mira
WorkingDirectory=/srv/mira/app
EnvironmentFile=/srv/mira/app/.env
ExecStart=/usr/bin/pnpm --filter @mira/server start
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mira
curl -s http://127.0.0.1:8787/health      # 应返回健康信息
journalctl -u mira -f                      # 看日志（日志里不会打印 Key）
```

## 5. Caddy（HTTPS + 静态文件 + 反向代理）

`/etc/caddy/Caddyfile`（把 `mira.example.com` 换成你的域名，DNS 先指到服务器 IP）：

```caddy
mira.example.com {
    encode zstd gzip

    # 服务端接口：WebSocket、握手令牌、生成图片、观测、健康检查
    @api path /ws /session-token /generated/* /obs/* /health
    handle @api {
        reverse_proxy 127.0.0.1:8787
    }

    # 前端静态文件（单页应用：找不到的路径回落到 index.html）
    handle {
        root * /srv/mira/app/apps/client/dist
        try_files {path} /index.html
        file_server
    }

    header {
        Strict-Transport-Security "max-age=31536000"
        X-Content-Type-Options nosniff
        -Server
    }
}
```

```bash
sudo systemctl reload caddy
```

Caddy 会自动申请 HTTPS 证书（需要 80/443 端口对外开放）。WebSocket 由 `reverse_proxy` 自动处理，无需额外配置。

## 6. 上线检查

1. 浏览器打开 `https://<域名>/`：首页能看到忧奈直播间，Live2D 在动。
2. 发一条文字：有语音、有字幕，四态切换正常。
3. 按住麦克风说话（浏览器会请求麦克风权限）：能识别、能回复。
4. 忧奈说话时按麦克风或点画面：立即停下并进入倾听。
5. 首页「文档」「观测」入口能打开。
6. 手机（iPhone Safari）打开同一地址测一遍：竖屏布局、语音播放（iOS 需要先有一次用户点击才能出声）。

## 7. 更新与回滚

```bash
sudo -iu mira
cd /srv/mira/app
git fetch && git log --oneline -1 origin/main     # 看要上线的版本
PREV=$(git rev-parse --short HEAD)
git pull --ff-only
pnpm install --frozen-lockfile && pnpm --filter @mira/client build
exit
sudo systemctl restart mira
# 有问题回滚：
#   sudo -iu mira; cd /srv/mira/app; git checkout $PREV; pnpm install --frozen-lockfile; pnpm --filter @mira/client build; exit
#   sudo systemctl restart mira
```

## 8. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 麦克风按钮无反应 | 不是 HTTPS。必须通过域名 + Caddy 访问 |
| 页面能开但一直「连接中」 | `/ws` 或 `/session-token` 没反代到 8787；`systemctl status mira` 看服务端是否在跑 |
| 有字幕没声音（真实模式） | Fish Key 失效或余额不足；`journalctl -u mira` 里看 Fish 报错。临时可切 `PROVIDER_MODE=mock` |
| 换背景一直失败 | 没配 `IMAGE_*` 或生图服务不可用；这是预期的失败兜底，不影响主流程 |
| 生成图片 404 | `GENERATED_DIR` 目录不存在或 mira 用户没有写权限 |
| 构建报内存不足 | 1GB 内存机器构建 Vite 可能 OOM：加 swap，或在本机 `pnpm --filter @mira/client build` 后把 `apps/client/dist` 用 rsync 传上去 |

## 9. 当前限制（部署前知悉）

- 服务端本身不托管前端静态文件，必须由 Caddy（或 Nginx）托管 `apps/client/dist`。
- 会话状态在内存里，重启服务端会断开所有会话（客户端会提示并可重连）。
- 单进程，不支持多实例负载均衡（题目明确不需要大规模生产环境）。
