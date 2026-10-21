'use strict';

/**
 * nodejs-argo —— Xray + Cloudflare Tunnel 一键节点（干净版）
 *
 * 特点：
 *   1. 只依赖 Node.js 内置模块，不需要 npm install；
 *   2. Xray / cloudflared 全部从官方 GitHub Release 下载，可用 DOWNLOAD_MIRROR 走加速；
 *   3. 没有任何内置的 UUID / 隧道 token，全部由环境变量提供；
 *   4. 支持两种 Argo 模式：
 *      - 临时隧道（不填 ARGO_AUTH）：cloudflared 生成 https://xxx.trycloudflare.com，重启后域名会变；
 *      - 固定隧道（填 ARGO_AUTH）：用自己的 Cloudflare Tunnel token，配合 ARGO_DOMAIN 得到固定域名。
 *
 * 环境变量见 README.md / .env.example
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const BIN_DIR = path.join(DATA_DIR, 'bin');

const PORT = toInt(process.env.PORT || process.env.SERVER_PORT, 3000);
const SUB_PATH = (process.env.SUB_PATH || 'sub').replace(/^\/+|\/+$/g, '') || 'sub';
const ARGO_PORT = toInt(process.env.ARGO_PORT, 8001);
const ARGO_AUTH = (process.env.ARGO_AUTH || '').trim();
const ARGO_DOMAIN = (process.env.ARGO_DOMAIN || '').trim().toLowerCase();
const CFIP = (process.env.CFIP || '').trim();
const CFPORT = toInt(process.env.CFPORT, 443);
const NAME = (process.env.NAME || '').trim();
const MIRROR = (process.env.DOWNLOAD_MIRROR || '').trim();
const WSPATH = {
  vless: '/vless-argo',
  vmess: '/vmess-argo',
  trojan: '/trojan-argo',
};
const EARLY_DATA = 2560;

// 仓库原 index.js 里写死的公共隧道 token 的 Tunnel ID：用了它等于流量走别人的隧道，这里直接拒绝。
const FORBIDDEN_TUNNEL_IDS = new Set(['540ad9ca-7c64-42e8-8b7e-0e71f2d18682']);

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function toInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function loadUuid() {
  const fromEnv = (process.env.UUID || '').trim();
  if (fromEnv) return fromEnv;

  const file = path.join(DATA_DIR, 'uuid');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved) return saved;
  } catch {
    /* 首次启动没有这个文件 */
  }

  const generated = crypto.randomUUID();
  ensureDir(DATA_DIR);
  fs.writeFileSync(file, generated + '\n');
  log(`未设置 UUID，已生成并保存到 ${file}：${generated}`);
  return generated;
}

function tunnelIdOf(token) {
  if (!token) return '';
  try {
    const json = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
    return typeof json.t === 'string' ? json.t : '';
  } catch {
    return '';
  }
}

function assertSafeConfig() {
  const id = tunnelIdOf(ARGO_AUTH);
  if (id && FORBIDDEN_TUNNEL_IDS.has(id)) {
    throw new Error(
      'ARGO_AUTH 是仓库自带的公共隧道 token，请不要使用！\n' +
        '请到 Cloudflare Zero Trust -> Networks -> Tunnels 创建你自己的隧道，复制它给你的 token。'
    );
  }
}


// ---------------------------------------------------------------------------
// 下载 & 解压（官方 Release）
// ---------------------------------------------------------------------------
function archiveName() {
  switch (process.arch) {
    case 'arm64':
      return 'arm64-v8a';
    case 'arm':
      return 'arm32-v7a';
    default:
      return '64';
  }
}

function cloudflaredAsset() {
  switch (process.arch) {
    case 'arm64':
      return 'cloudflared-linux-arm64';
    case 'arm':
      return 'cloudflared-linux-arm';
    default:
      return 'cloudflared-linux-amd64';
  }
}

function withMirror(url) {
  return MIRROR ? MIRROR.replace(/\/+$/, '') + '/' + url : url;
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const fail = (err) => {
      file.destroy();
      fs.rm(dest, { force: true }, () => reject(err));
    };

    const get = (current, redirects) => {
      const req = https.get(
        current,
        { headers: { 'User-Agent': 'nodejs-argo' }, timeout: 30000 },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            if (redirects >= 6) return fail(new Error('重定向次数过多: ' + current));
            return get(new URL(res.headers.location, current).toString(), redirects + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return fail(new Error(`下载失败 HTTP ${res.statusCode}: ${current}`));
          }
          res.on('error', fail);
          res.pipe(file);
          file.on('finish', () => file.close(() => resolve(dest)));
          file.on('error', fail);
        }
      );
      req.on('timeout', () => req.destroy(new Error('下载超时: ' + current)));
      req.on('error', fail);
    };

    get(withMirror(url), 0);
  });
}

/** 只解 zip 里需要的那个文件，避免依赖 unzip 命令 */
function extractFromZip(zipPath, fileName, destPath) {
  const buf = fs.readFileSync(zipPath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件: ' + zipPath);

  const total = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('zip 目录损坏');
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);

    if (path.basename(name) === fileName) {
      const localNameLen = buf.readUInt16LE(localOffset + 26);
      const localExtraLen = buf.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLen + localExtraLen;
      const raw = buf.subarray(start, start + compressedSize);
      const data = method === 0 ? raw : zlib.inflateRawSync(raw);
      fs.writeFileSync(destPath, data);
      fs.chmodSync(destPath, 0o755);
      return destPath;
    }

    offset += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`zip 里没有找到 ${fileName}`);
}

async function ensureBinaries() {
  ensureDir(BIN_DIR);

  const usable = (file, minSize) => {
    try {
      return fs.statSync(file).size > minSize;
    } catch {
      return false;
    }
  };

  const xrayPath = path.join(BIN_DIR, 'xray');
  if (!usable(xrayPath, 1024 * 1024)) {
    const zipUrl = `https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-${archiveName()}.zip`;
    const zipPath = path.join(BIN_DIR, 'xray.zip');
    log('下载 Xray-core:', withMirror(zipUrl));
    await download(zipUrl, zipPath);
    extractFromZip(zipPath, 'xray', xrayPath);
    fs.rmSync(zipPath, { force: true });
    log('Xray-core 就绪:', xrayPath);
  }

  const cfPath = path.join(BIN_DIR, 'cloudflared');
  if (!usable(cfPath, 1024 * 1024)) {
    const cfUrl = `https://github.com/cloudflare/cloudflared/releases/latest/download/${cloudflaredAsset()}`;
    log('下载 cloudflared:', withMirror(cfUrl));
    await download(cfUrl, cfPath);
    fs.chmodSync(cfPath, 0o755);
    log('cloudflared 就绪:', cfPath);
  }

  return { xrayPath, cfPath };
}


// ---------------------------------------------------------------------------
// Xray 配置
// ---------------------------------------------------------------------------
function buildXrayConfig(uuid) {
  const sniffing = { enabled: true, destOverride: ['http', 'tls', 'quic'], metadataOnly: false };

  const wsInbound = (tag, port, protocol, settings, wsPath) => ({
    tag,
    listen: '127.0.0.1',
    port,
    protocol,
    settings,
    streamSettings: { network: 'ws', security: 'none', wsSettings: { path: wsPath } },
    sniffing,
  });

  return {
    log: { loglevel: 'warning' },
    inbounds: [
      {
        // Argo 的流量先到这里：不是 VLESS 的请求按 path 分流给下面的 ws 入口
        tag: 'front',
        listen: '0.0.0.0',
        port: ARGO_PORT,
        protocol: 'vless',
        settings: {
          clients: [{ id: uuid }],
          decryption: 'none',
          // 不是 VLESS 的请求按 path 分流给下面的 ws 入口，其余交给本地状态页
          fallbacks: [
            { dest: PORT },
            { path: WSPATH.vless, dest: 3002 },
            { path: WSPATH.vmess, dest: 3003 },
            { path: WSPATH.trojan, dest: 3004 },
          ],
        },
        streamSettings: { network: 'tcp', security: 'none' },
        sniffing,
      },
      wsInbound('vless-ws', 3002, 'vless', { clients: [{ id: uuid }], decryption: 'none' }, WSPATH.vless),
      wsInbound('vmess-ws', 3003, 'vmess', { clients: [{ id: uuid, alterId: 0 }] }, WSPATH.vmess),
      wsInbound('trojan-ws', 3004, 'trojan', { clients: [{ password: uuid }] }, WSPATH.trojan),
    ],
    dns: { servers: ['https+local://1.1.1.1/dns-query', 'localhost'] },
    outbounds: [
      { protocol: 'freedom', tag: 'direct' },
      { protocol: 'blackhole', tag: 'block' },
    ],
    // 免费平台一般禁止 BT，这里直接拦掉，避免被判定滥用
    routing: { rules: [{ type: 'field', protocol: ['bittorrent'], outboundTag: 'block' }] },
  };
}

// ---------------------------------------------------------------------------
// 订阅内容
// ---------------------------------------------------------------------------
let UUID = '';
let publicHost = ARGO_DOMAIN;
let subscription = '';
const startedAt = Date.now();

function buildLinks(host) {
  const addr = CFIP || host;
  const label = encodeURIComponent(NAME ? `${NAME}-${host}` : host);
  const query = (p) => encodeURIComponent(`${p}?ed=${EARLY_DATA}`);

  const vless =
    `vless://${UUID}@${addr}:${CFPORT}` +
    `?encryption=none&security=tls&sni=${host}&fp=firefox&type=ws&host=${host}` +
    `&path=${query(WSPATH.vless)}#${label}`;

  const vmess = {
    v: '2',
    ps: NAME ? `${NAME}-${host}` : host,
    add: addr,
    port: String(CFPORT),
    id: UUID,
    aid: '0',
    scy: 'auto',
    net: 'ws',
    type: 'none',
    host,
    path: `${WSPATH.vmess}?ed=${EARLY_DATA}`,
    tls: 'tls',
    sni: host,
    alpn: '',
    fp: 'firefox',
  };

  const trojan =
    `trojan://${UUID}@${addr}:${CFPORT}` +
    `?security=tls&sni=${host}&fp=firefox&type=ws&host=${host}` +
    `&path=${query(WSPATH.trojan)}#${label}`;

  return [
    vless,
    'vmess://' + Buffer.from(JSON.stringify(vmess)).toString('base64'),
    trojan,
  ];
}

function refreshSubscription() {
  if (!publicHost) return;
  subscription = Buffer.from(buildLinks(publicHost).join('\n') + '\n').toString('base64');
  log(`订阅已生成，域名: ${publicHost}，订阅路径: /${SUB_PATH}`);
}


// ---------------------------------------------------------------------------
// 本地 HTTP 服务（状态页 + 订阅）
// ---------------------------------------------------------------------------
function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(text).replace(/[&<>"']/g, (c) => map[c]);
}

function statusPage() {
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>nodejs-argo</title>
<style>
  body{font-family:system-ui,-apple-system,"Noto Sans SC",sans-serif;background:#0b1020;color:#e8ecf5;margin:0;padding:40px 20px}
  .card{max-width:640px;margin:0 auto;background:#151b30;border:1px solid #262f4d;border-radius:14px;padding:28px}
  h1{font-size:22px;margin:0 0 6px}
  .ok{color:#4ade80}
  .muted{color:#8b96b3;font-size:13px}
  code{background:#0e1426;border:1px solid #26304f;border-radius:6px;padding:2px 6px;font-size:13px;word-break:break-all}
  table{width:100%;border-collapse:collapse;margin-top:18px;font-size:14px}
  td{padding:8px 0;border-bottom:1px solid #232c49;vertical-align:top}
  td:first-child{color:#8b96b3;width:110px}
</style>
</head>
<body>
  <div class="card">
    <h1>nodejs-argo <span class="ok">运行中</span></h1>
    <div class="muted">Xray + Cloudflare Tunnel</div>
    <table>
      <tr><td>域名</td><td>${publicHost ? `<code>${escapeHtml(publicHost)}</code>` : '等待 Argo 分配…'}</td></tr>
      <tr><td>订阅路径</td><td><code>/${escapeHtml(SUB_PATH)}</code></td></tr>
      <tr><td>协议</td><td>VLESS / VMess / Trojan（WebSocket + TLS）</td></tr>
      <tr><td>UUID</td><td><code>${escapeHtml(UUID.length > 12 ? UUID.slice(0, 8) + '••••' + UUID.slice(-4) : '已设置')}</code>（完整值见启动日志）</td></tr>
      <tr><td>运行时长</td><td>${hours} 小时 ${minutes} 分</td></tr>
    </table>
  </div>
</body>
</html>`;
}

function startHttpServer() {
  const server = http.createServer((req, res) => {
    const pathname = (req.url || '/').split('?')[0];

    if (pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('ok');
    }

    if (pathname === '/' + SUB_PATH) {
      res.writeHead(subscription ? 200 : 503, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return res.end(subscription || '节点还在启动中，请稍后再试。');
    }

    if (pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(statusPage());
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  });

  server.listen(PORT, '0.0.0.0', () => log(`本地 HTTP 服务已启动: http://0.0.0.0:${PORT}`));
  return server;
}

// ---------------------------------------------------------------------------
// 子进程管理
// ---------------------------------------------------------------------------
let stopping = false;
const children = new Set();
let binaries = null;
let configPath = '';

function supervise(name, command, args, onLine) {
  if (stopping) return null;

  const safeArgs = args.map((a) => (a.length > 60 ? a.slice(0, 10) + '…' : a));
  log(`启动 ${name}: ${command} ${safeArgs.join(' ')}`);

  const child = spawn(command, args, { cwd: DATA_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);

  const handle = (stream) => {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        const text = line.trim();
        if (!text) continue;
        log(`[${name}] ${text}`);
        if (onLine) onLine(text);
      }
    });
  };
  handle(child.stdout);
  handle(child.stderr);

  child.on('error', (err) => log(`${name} 启动失败:`, err.message));
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (stopping) return;
    log(`${name} 已退出 (code=${code}, signal=${signal})，3 秒后重启`);
    setTimeout(() => {
      if (stopping) return;
      if (name === 'xray') startXray();
      else startArgo();
    }, 3000).unref();
  });

  return child;
}

function startXray() {
  supervise('xray', binaries.xrayPath, ['run', '-c', configPath], null);
}

const QUICK_TUNNEL_RE = /https:\/\/([a-z0-9][a-z0-9-]*\.trycloudflare\.com)/i;

function onArgoLine(line) {
  const match = line.match(QUICK_TUNNEL_RE);
  if (match && match[1].toLowerCase() !== publicHost) {
    publicHost = match[1].toLowerCase();
    refreshSubscription();
    log(`Argo 临时域名: https://${publicHost}`);
    log(`订阅地址: https://${publicHost}/${SUB_PATH}`);
  }
}

function argoArgs() {
  const base = ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--edge-ip-version', 'auto'];

  // 模式 1：完整凭据 JSON（含 TunnelSecret），自己写 config.yml
  if (ARGO_AUTH && ARGO_AUTH.includes('TunnelSecret')) {
    let tunnelId = '';
    try {
      tunnelId = JSON.parse(ARGO_AUTH).TunnelID || '';
    } catch {
      throw new Error('ARGO_AUTH 看起来是凭据 JSON，但无法解析');
    }
    if (!tunnelId) throw new Error('ARGO_AUTH 里找不到 TunnelID');
    if (!ARGO_DOMAIN) throw new Error('使用凭据 JSON 模式时必须设置 ARGO_DOMAIN');

    const credPath = path.join(DATA_DIR, 'tunnel.json');
    fs.writeFileSync(credPath, ARGO_AUTH);
    const ymlPath = path.join(DATA_DIR, 'tunnel.yml');
    fs.writeFileSync(
      ymlPath,
      [
        `tunnel: ${tunnelId}`,
        `credentials-file: ${credPath}`,
        'protocol: http2',
        '',
        'ingress:',
        `  - hostname: ${ARGO_DOMAIN}`,
        `    service: http://localhost:${ARGO_PORT}`,
        '    originRequest:',
        '      noTLSVerify: true',
        '  - service: http_status:404',
        '',
      ].join('\n')
    );
    return base.concat(['--config', ymlPath, 'run']);
  }

  // 模式 2：Tunnel token（Cloudflare Zero Trust 面板里复制的那串）
  if (ARGO_AUTH) {
    return base.concat(['run', '--url', `http://localhost:${ARGO_PORT}`, '--token', ARGO_AUTH]);
  }

  // 模式 3：临时隧道，不需要账号，域名重启就变
  return base.concat(['--url', `http://localhost:${ARGO_PORT}`, '--loglevel', 'info']);
}

function startArgo() {
  if (!ARGO_AUTH && ARGO_DOMAIN) {
    log('提示：没有 ARGO_AUTH 时会走临时隧道，ARGO_DOMAIN 会被忽略。');
  }
  if (ARGO_AUTH && !ARGO_DOMAIN) {
    log('提示：设置了 ARGO_AUTH 但没设置 ARGO_DOMAIN，订阅里的域名可能不对，建议补上。');
  }
  supervise('cloudflared', binaries.cfPath, argoArgs(), onArgoLine);
}

// ---------------------------------------------------------------------------
// 启动 & 退出
// ---------------------------------------------------------------------------
async function main() {
  assertSafeConfig();

  ensureDir(DATA_DIR);
  ensureDir(BIN_DIR);

  UUID = loadUuid();
  log('UUID:', UUID);
  log('数据目录:', DATA_DIR);

  binaries = await ensureBinaries();

  configPath = path.join(DATA_DIR, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(buildXrayConfig(UUID), null, 2));
  log('Xray 配置已写入:', configPath);

  startHttpServer();
  startXray();
  await new Promise((resolve) => setTimeout(resolve, 1500));
  startArgo();

  if (ARGO_DOMAIN) refreshSubscription();
  log('启动完成。状态页: / ，订阅: /' + SUB_PATH);
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log(`收到 ${signal}，正在退出…`);
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* 忽略 */
    }
  }
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => log('未处理的 Promise 异常:', (err && err.message) || err));

main().catch((err) => {
  console.error('启动失败:', (err && err.message) || err);
  process.exit(1);
});
