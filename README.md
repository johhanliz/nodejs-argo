# nodejs-argo

用 **Xray + Cloudflare Tunnel** 在免费容器平台上跑一个自己的节点。
不需要买服务器；没有域名也能先用起来。

> 仅供个人学习、研究与隐私保护使用。请遵守你所在地区的法律法规，以及所用云平台的 ToS。

## 工作原理

```
你的设备（v2rayN / v2rayNG / Clash / sing-box）
        │  VLESS / VMess / Trojan over WebSocket + TLS
        ▼
Cloudflare 边缘节点（443，你的域名 或 xxx.trycloudflare.com）
        │  Cloudflare Tunnel：容器主动向外建连，不用公网 IP、不用开端口
        ▼
容器里的 cloudflared  →  localhost:8001
        ▼
Xray（按 path 分流：/vless-argo、/vmess-argo、/trojan-argo）
        ▼
自由出网
```

## 你需要准备什么

| 需要 | 是否必须 | 说明 |
| --- | --- | --- |
| Cloudflare 账号 | 固定域名时必需 | 邮箱注册即可，免费 |
| 一个域名 | 可选 | 没有就用临时隧道 |
| 能跑 Docker / Node 18+ 的平台 | 必需 | 免费额度就够，见下方清单 |

## 方案一：没有域名，5 分钟先用起来（临时隧道）

```bash
git clone https://github.com/johhanliz/nodejs-argo.git
cd nodejs-argo
git checkout cline/xs0g2ef7        # 这一版的新实现；合并到 main 后可省略

docker build -t argo-node .
docker run -d --name argo-node \
  -p 3000:3000 \
  -e UUID=$(node -e "console.log(crypto.randomUUID())") \
  -e NAME=my-node \
  argo-node

docker logs -f argo-node
```

日志里会出现：

```
Argo 临时域名: https://xxxx-yyyy.trycloudflare.com
订阅地址: https://xxxx-yyyy.trycloudflare.com/sub
```

把订阅地址填进客户端就能用。没有 Docker 也可以直接跑：

```bash
npm install
node server.js
```

首次启动会从 GitHub 下载 Xray 和 cloudflared（约 70MB），放到 `data/` 目录。

**临时模式的缺点**：域名是 Cloudflare 随机分配的，容器重启或平台休眠后就会变，需要重新取订阅。要固定域名请看方案二。

## 方案二：固定域名（推荐）

### 1. 域名接入 Cloudflare

- 已有域名：在 Cloudflare 添加站点，按提示把域名的 NS 改成 Cloudflare 给的两个地址。
- 没有域名：可以用提供免费二级域名的服务（例如 DigitalPlat FreeDomain 的 `dpdns.org`、`us.kg` 等），把它的 NS 指向 Cloudflare。这类服务政策会变，注册前自行确认。

等 Cloudflare 显示站点 **Active** 再继续。

### 2. 创建 Tunnel 并绑定域名

1. 打开 <https://one.dash.cloudflare.com> → **Networks → Tunnels → Create a tunnel**
2. 选 **Cloudflared**，起个名字（例如 `my-node`），保存
3. 复制页面上那条 `eyJhIjoi...` 开头的 **token**（这就是 `ARGO_AUTH`）
4. 切到 **Public Hostname** 标签 → **Add a public hostname**
   - Subdomain: `node`
   - Domain: 你的域名
   - Service Type: `HTTP`
   - URL: `localhost:8001`
5. 保存。之后 `node.你的域名` 就指向容器里的 Xray。

> 本项目启动 cloudflared 时也带了 `--url http://localhost:8001`，所以即使面板里没配 Public Hostname，token 模式也会把流量回源到 8001；但域名解析（DNS 记录）仍需要在面板里绑定。

### 3. 部署并填入三个变量

```bash
git clone https://github.com/johhanliz/nodejs-argo.git
cd nodejs-argo
git checkout cline/xs0g2ef7

docker build -t argo-node .
docker run -d --name argo-node \
  -p 3000:3000 \
  -e UUID=$(node -e "console.log(crypto.randomUUID())") \
  -e ARGO_AUTH='你复制的 token' \
  -e ARGO_DOMAIN='node.你的域名' \
  -e NAME=HK \
  argo-node
```

启动后订阅地址是：

```
https://node.你的域名/sub
```


## 部署到免费容器平台

只要平台满足下面几条，就能跑：

- 能跑 Docker 镜像（或 Node.js 18+）
- 允许容器**主动出站**访问 443（Cloudflare 隧道要连 `*.argotunnel.com`）
- 有 300MB 以上内存（Xray + cloudflared 常驻约 150MB）
- 允许长期运行；会休眠的平台需要定时唤醒，否则隧道会断

常见选择（免费额度、是否要信用卡、是否允许代理都在变，注册前请自行看清条款）：

| 平台 | 形式 | 注意 |
| --- | --- | --- |
| Koyeb | Docker 镜像 / GitHub 仓库 | 免费实例会缩容到 0，需要访问唤醒 |
| Render | Docker / Node | 免费 Web Service 15 分钟无流量会休眠 |
| ClawCloud Run | Docker 镜像 | 有免费额度，需 GitHub 账号 |
| Zeabur / Railway | Docker / GitHub | 有试用额度，超出收费 |
| 自己的 VPS / 家里的小主机 | Docker | 最稳，不受平台 ToS 影响 |
| Oracle Cloud 永久免费 | 完整 VPS | 注册要信用卡验证 |

以 Koyeb 为例（图形界面）：

1. Create Service → **GitHub** → 选择本仓库，分支 `cline/xs0g2ef7`（合并后选 `main`）
2. Builder 选 **Dockerfile**
3. Instance: 最小的免费规格
4. Environment variables 填 `UUID`、`ARGO_AUTH`、`ARGO_DOMAIN`、`NAME`
5. Port: `3000`（HTTP，用于健康检查）
6. Deploy，日志里看到 `启动完成` 即可

> 仓库自带的 Actions 会在 `main` 分支构建镜像 `ghcr.io/<你的用户名>/nodejs:latest`。等它构建过一次之后再直接用镜像部署会更省事。

## 用 Docker Compose（本地 / VPS）

```bash
cp .env.example .env
# 编辑 .env，至少填 UUID；想固定域名再填 ARGO_AUTH / ARGO_DOMAIN
docker compose up -d --build
docker compose logs -f
```

`./data` 会保存 uuid、下载好的二进制和配置，删掉它等于重置节点。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `UUID` | 自动生成 | 节点密码（客户端里的 id），建议自己指定并保存好 |
| `ARGO_AUTH` | 空 | Tunnel token；留空 = 临时隧道 |
| `ARGO_DOMAIN` | 空 | 隧道绑定的域名，临时模式不用填 |
| `PORT` | `3000` | 状态页 / 订阅端口，平台一般会注入 |
| `SUB_PATH` | `sub` | 订阅路径，`/sub`；建议改复杂一点 |
| `ARGO_PORT` | `8001` | Xray 回源端口，Cloudflare 的 Public Hostname 要指向它 |
| `NAME` | 空 | 节点名前缀，例如 `HK` |
| `CFIP` | 空 | 优选 IP / 优选域名；不填就用 Argo 域名 |
| `CFPORT` | `443` | 节点端口 |
| `DOWNLOAD_MIRROR` | 空 | GitHub 加速前缀，例如 `https://ghfast.top` |
| `DATA_DIR` | `./data` | 数据目录 |

订阅里会生成 3 个节点（VLESS / VMess / Trojan，都是 WebSocket + TLS），随便用哪个。

## 客户端导入

- **v2rayN（Windows）**：订阅 → 订阅分组设置 → 添加，URL 填 `https://你的域名/sub`
- **v2rayNG / NekoBox（Android）**：右上角 + → 从剪贴板导入 / 订阅
- **Clash Verge / Mihomo**：订阅里填 URL（本项目输出的是 base64 节点列表，Mihomo 能直接识别）
- **sing-box**：用 `sing-box` 的 remote profile 或直接把链接导入

导入后测一下延迟，能出网就成功了。

## 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| `/sub` 返回 503 | 节点还在启动，等 10~30 秒再刷新 |
| 状态页打不开 | cloudflared 没连上，看日志里有没有 `Registered tunnel connection` |
| 状态页正常但节点不通 | 检查 UUID、`path`、`sni/host` 是否和订阅一致；确认端口是 443 |
| 日志 `Provided Tunnel token is not valid` | `ARGO_AUTH` 复制不完整，重新复制整串 |
| 日志里出现下载失败 | 换网络重试，或设置 `DOWNLOAD_MIRROR` 走加速 |
| 平台封号 / 服务被删 | 免费平台多数禁止代理用途，换平台或用自己的 VPS |
| 大陆访问 `trycloudflare.com` 不稳 | 改用固定域名，并考虑设置 `CFIP` 优选 IP |

## 安全提醒

- 仓库原来的 `index.js` 里内置了一个**公共的 Argo token**（`ARGO_AUTH` 默认值），用它等于流量走别人的隧道。`server.js` 检测到该 token 会直接拒绝启动。
- 订阅地址就是密码，不要发到公开群组或仓库里。
- 平台后台的日志会打印 UUID，介意的话部署后改掉 `UUID` 重启。
- 本项目默认拦截 BitTorrent，避免被平台判定滥用。

## 和原来的 index.js 有什么区别

| | `index.js`（原版） | `server.js`（本版） |
| --- | --- | --- |
| 代码 | 混淆过的 200KB，难审计 | 500 多行可读代码 |
| 二进制来源 | 第三方 `*.ssss.nyc.mn` | 官方 GitHub Release |
| 默认 UUID / token | 写死公共值 | 无，必须自己提供 |
| 临时隧道 | 实际不可用（默认值把分支堵死） | 支持，自动解析 `trycloudflare.com` |
| 订阅地址 | 依赖 `PROJECT_URL` 等外部服务 | 直接由本机提供 |
| 哪吒探针 | 内置 | 不包含 |

原版仍然保留，想继续用可以 `npm run start:legacy`。

## 目录结构

```
server.js          # 入口：下载二进制、生成配置、起 Xray / cloudflared / HTTP 服务
index.js           # 原版（保留）
Dockerfile         # 镜像构建
docker-compose.yml # 本地 / VPS 一键启动
.env.example       # 环境变量模板
data/              # 运行时生成：uuid、bin/、config.json（已 gitignore）
```

## License

MIT

打开 `https://node.你的域名/` 能看到状态页，就说明整条链路通了。
