# nodejs-argo

sing-box + Cloudflare Argo 隧道的自建节点，附带一个伪装用的静态官网页面。

- 内核：sing-box，提供 **VLESS / VMess / Trojan（WebSocket over TLS）** 节点
- 隧道：cloudflared 主动外连 Cloudflare，无需公网 IP、无需开放入站端口
- 伪装：`index.html` 是一个「CodeFlow」产品官网，直接对外提供
- 订阅：节点链接以 base64 形式发布在 `/<SUB_PATH>`
- 可选：哪吒探针（`NEZHA_*`）

## 运行原理

```
客户端 --TLS/443--> Cloudflare 边缘 --隧道--> 容器内 cloudflared
                                                    |
                                                    v  http://localhost:8080
                                             sing-box (ARGO_PORT)
                                        /vless-argo  /vmess-argo  /trojan-argo
                                                    |
                                        其余请求 fallback -> 3001（伪装网页）
```

| 端口（容器内） | 用途 |
| --- | --- |
| `PORT`（默认 3001） | 伪装网页 `index.html` + 订阅 `/<SUB_PATH>` |
| `ARGO_PORT`（默认 8080） | sing-box 入口，**隧道回源必须指向这里** |
| 3001 | sing-box 的 HTTP fallback 目标（写死），所以 `PORT` 保持 `3001` 才能让隧道回源命中伪装网页和订阅 |
| 3002 / 3003 / 3004 | sing-box 内部 WS 入站，仅监听 127.0.0.1 |

订阅路径：`http://127.0.0.1:${PORT}/${SUB_PATH}`（默认 `/jl`），内容是 base64 编码的 vless / vmess / trojan 三条链接。

## ⚠️ 安全与合规提醒（务必先看）

1. **必须使用自己的 Cloudflare 隧道。** `index.js` 是混淆代码，当 `ARGO_AUTH` 为空时会退回到**脚本内置的第三方隧道 Token 和域名**，你的流量会经过别人的隧道，存在被监听、随时失效的风险。本项目已通过 `scripts/setup.sh` 强制要求填写 `ARGO_AUTH`。
2. **二进制是运行时从第三方下载的。** 启动时脚本会从 `amd64.ssss.nyc.mn` / `arm64.ssss.nyc.mn` 拉取 sing-box 和 cloudflared（约 75 MB，放在 `.tmp/`），无法校验来源。介意的话可自行替换为官方二进制并放进 `.tmp/`。
3. **不要监听公网。** 默认 `docker-compose.yml` 不映射任何端口，cloudflared 是出站连接，最安全；除非需要直连，否则不要 `ports:` 暴露 3001/8080。
4. **合规使用。** 请遵守你所在地区的法律法规以及 [Cloudflare 服务条款](https://www.cloudflare.com/website-terms/)。不要用于攻击、滥用或绕过你无权访问的资源。

## 快速部署（VPS + Docker）

### 0. 前置条件

- 一台能访问外网的 Linux 服务器（1 核 512 MB 起）
- 一个已托管在 Cloudflare 的域名
- Docker + Docker Compose v2

```bash
# Debian / Ubuntu 示例
curl -fsSL https://get.docker.com | sh
```

### 1. 在 Cloudflare 创建隧道

1. 打开 [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) → **Networks → Tunnels → Create a tunnel**
2. 选择 **Cloudflared**，起个名字，保存
3. 在安装页复制 **Token**（形如 `eyJhIjoi...` 的长字符串）
4. 切到 **Public Hostname** 标签，添加一条：
   - Subdomain / Domain：`node.example.com`（你自己的域名）
   - Service：`HTTP` → `localhost:8080`
5. 保存。**注意 Service 必须是 `localhost:8080`**（与 `.env` 里的 `ARGO_PORT` 一致），因为 cloudflared 和 sing-box 在同一个容器里。

> 域名必须保持 Cloudflare 代理开启（橙色云朵），否则 TLS/WS 无法正常回源。

### 2. 生成配置

```bash
cp .env.example .env         # 也可以直接跑下一步的 setup.sh，它会自动生成 UUID
bash scripts/setup.sh
```

交互式输入隧道域名和 Token 即可，脚本会自动生成 UUID 并写入 `.env`（权限 600）。
也可以非交互：

```bash
ARGO_DOMAIN=node.example.com \
ARGO_AUTH='eyJhIjoi...' \
bash scripts/setup.sh
```

关键变量：

| 变量 | 说明 |
| --- | --- |
| `UUID` | 节点 UUID，`setup.sh` 自动生成 |
| `ARGO_AUTH` | 你自己的 Cloudflare 隧道 Token（**必填**） |
| `ARGO_DOMAIN` | 隧道绑定的域名，必须与 Public Hostname 一致 |
| `CFIP` | 客户端连接地址，一般填 `ARGO_DOMAIN`，也可以填 Cloudflare 优选 IP |
| `CFPORT` | 客户端连接端口，走 Cloudflare 固定 `443` |
| `SUB_PATH` | 订阅路径，默认 `jl` |
| `NAME` | 节点显示名称 |

### 3. 启动

```bash
docker compose up -d --build
docker compose logs -f
```

首次启动会下载二进制并生成 `config.json`、`sub.txt`，大约 30–60 秒。

### 4. 验证

```bash
curl -I http://127.0.0.1:3001/          # 应返回 200，内容是伪装官网
bash scripts/get-sub.sh                 # 打印 vless:// vmess:// trojan:// 链接
curl -I https://node.example.com/       # 走隧道访问，应返回 200
curl -fsS https://node.example.com/jl | base64 -d   # 走隧道取订阅
```

### 5. 客户端导入

- 订阅地址（把域名换成你的）：`https://node.example.com/jl`
  - 请求经 Cloudflare → 隧道 → sing-box:8080 → fallback 到 3001，由 Node 返回 base64 订阅。
- 手动导入：执行 `bash scripts/get-sub.sh`，把输出的三条链接分别导入 v2rayN / NekoBox / sing-box 等客户端。


## 不用 Docker（直接跑 Node）

需要 Node.js 18+：

```bash
npm install
set -a; . ./.env; set +a
node index.js
```

用 systemd 托管示例（`/etc/systemd/system/nodejs-argo.service`）：

```ini
[Unit]
Description=nodejs-argo
After=network-online.target

[Service]
WorkingDirectory=/opt/nodejs-argo
EnvironmentFile=/opt/nodejs-argo/.env
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now nodejs-argo
journalctl -u nodejs-argo -f
```

## 使用 CI 构建好的镜像

仓库里的 `.github/workflows/build-docker-image.yml` 会在推送 `main` 时构建多架构镜像并推到 GHCR：

```bash
docker pull ghcr.io/<你的GitHub用户名>/nodejs:latest
```

把 `docker-compose.yml` 里的 `build: ...` 换成：

```yaml
    image: ghcr.io/<你的GitHub用户名>/nodejs:latest
```

再执行 `docker compose up -d`。

## 常见问题

**隧道能通，但 `https://域名/` 返回 502 / 空白？**
sing-box 的 fallback 目标固定是 `3001`，请确认 `.env` 里 `PORT=3001`，并且容器处于 healthy 状态。

**订阅返回空 / 404？**
`sub.txt` 要等云隧道建立后才会生成（约 10–30 秒）。先看 `docker compose logs` 里有没有隧道注册成功的日志，再 `bash scripts/get-sub.sh`。订阅路径是 `/<SUB_PATH>`，默认 `/jl`，不要加 `.txt`。

**客户端连不上节点？**
- `UUID`、`ARGO_DOMAIN`、`CFIP` 三者要与隧道配置一致
- 域名的 Cloudflare 代理必须是开启状态（橙色云朵）
- 端口用 `443`，传输 `ws`，TLS 开启，SNI/Host 填 `ARGO_DOMAIN`
- `path` 必须是 `/vless-argo`（VLESS）、`/vmess-argo`（VMess）、`/trojan-argo`（Trojan）

**启动日志里出现 `trycloudflare.com`？**
说明 `ARGO_AUTH` 不是合法的 Token（脚本识别规则是 120–250 位字母数字），cloudflared 退化成了临时隧道。临时隧道域名每次都变、且订阅里的域名不会自动更新，请改用自己隧道的 Token。

**容器一直重启？**
`docker compose logs --tail=100` 看错误；常见原因是 `.env` 里 `ARGO_AUTH` 带了多余引号或换行、`ARGO_PORT` 被别的进程占用（容器内一般不会）。

**更新代码后？**

```bash
git pull
docker compose up -d --build
```

## 目录结构

```text
.
├── index.js            # 混淆后的主程序（sing-box + cloudflared + HTTP 服务）
├── index.html          # 伪装官网页面
├── Dockerfile          # node:alpine3.22 镜像
├── docker-compose.yml  # 一键部署（本文件新增）
├── .env.example        # 配置模板（本文件新增）
├── scripts/
│   ├── setup.sh        # 生成 .env，自动生成 UUID（新增）
│   └── get-sub.sh      # 本地取订阅并解码（新增）
└── .github/workflows/build-docker-image.yml
```

## 免责声明

本项目仅用于学习网络协议与自建服务。请自行承担部署与使用风险，遵守当地法律法规及 Cloudflare 服务条款。
