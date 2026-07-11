// BrowserOS driver — controls the user's real BrowserOS browser (logged-in
// sessions, real fingerprint) via its local MCP automation server. Because
// every action runs in a genuine human browser, submits clear the anti-bot
// walls (reCAPTCHA, email codes, spam-flags) that blocked headless Playwright.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// BrowserOS assigns its MCP server port dynamically and records it in its
// config file, which is the source of truth across restarts.
const CONFIG = path.join(os.homedir(), 'Library/Application Support/BrowserOS/.browseros/server_config.json');
function discoverUrl() {
  if (process.env.BOS_MCP) return process.env.BOS_MCP;
  try {
    const port = JSON.parse(fs.readFileSync(CONFIG, 'utf8')).ports.server;
    return `http://localhost:${port}/mcp`;
  } catch { return 'http://localhost:9201/mcp'; }
}
let MCP_URL = discoverUrl();

let rpcId = 100;
function rpc(method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params });
  const u = new URL(MCP_URL);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          // tolerate SSE framing ("data: {...}")
          let payload = data.trim();
          if (payload.startsWith('data:')) payload = payload.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
          try {
            const j = JSON.parse(payload);
            if (j.error) return reject(new Error(`${method}: ${j.error.message || JSON.stringify(j.error)}`));
            resolve(j.result);
          } catch (e) { reject(new Error(`${method}: bad response ${payload.slice(0, 200)}`)); }
        });
      });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error(`${method}: timeout`)));
    req.write(body);
    req.end();
  });
}

// rpc with retry + port re-discovery (BrowserOS bounces ports on restart)
async function rpcRetry(method, params, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await rpc(method, params); }
    catch (e) {
      lastErr = e;
      if (/ECONNREFUSED|ECONNRESET|socket hang up|timeout/i.test(e.message)) {
        await new Promise((r) => setTimeout(r, 1500));
        MCP_URL = discoverUrl();
        inited = false; // force re-init on next call path
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// tools/call wrapper → returns the concatenated text content
export async function call(tool, args = {}) {
  const r = await rpcRetry('tools/call', { name: tool, arguments: args });
  const text = (r?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r?.isError) throw new Error(`${tool} error: ${text.slice(0, 200)}`);
  return { text, structured: r?.structuredContent || null, raw: r };
}

let inited = false;
export async function init() {
  if (inited) return;
  MCP_URL = discoverUrl(); // re-read in case BrowserOS restarted on a new port
  await rpcRetry('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'intern-autopilot', version: '2' } });
  inited = true;
}

// ── convenience helpers ─────────────────────────────────────────────────────
export async function newTab(url, { background = true } = {}) {
  const { text, structured } = await call('tabs', { action: 'new', url, background });
  if (structured?.page != null) return structured.page;
  const m = text.match(/opened page (\d+)|\[(\d+)\]/);
  return m ? Number(m[1] || m[2]) : null;
}
export async function listTabs() { return (await call('tabs', { action: 'list' })).text; }
export async function closeTab(page) { return call('tabs', { action: 'close', page }); }
export async function navigate(page, url) { return call('navigate', { page, action: 'url', url }); }
export async function snapshot(page) { return (await call('snapshot', { page })).text; }
export async function act(page, opts) { return call('act', { page, ...opts }); }
export async function read(page, format = 'markdown') { return (await call('read', { page, format })).text; }
export async function grep(page, pattern) { return (await call('grep', { page, pattern })).text; }
export async function screenshot(page) { return call('screenshot', { page }); }
export async function upload(page, ref, paths) { return call('upload', { page, ref, paths: Array.isArray(paths) ? paths : [paths] }); }
function unwrap(text) {
  // BrowserOS wraps page-origin output in UNTRUSTED_PAGE_CONTENT markers with a
  // boilerplate warning line before the actual payload — strip both.
  const m = text.match(/\[UNTRUSTED_PAGE_CONTENT[^\]]*\]\s*([\s\S]*?)\s*\[END_UNTRUSTED_PAGE_CONTENT/);
  let body = (m ? m[1] : text).trim();
  body = body.replace(/^Untrusted page content follows\.[^\n]*\n?/i, '').trim();
  return body;
}
export async function evaluate(page, code) {
  const { text, structured } = await call('evaluate', { page, code });
  if (structured && 'result' in structured) return structured.result;
  const body = unwrap(text);
  try { return JSON.parse(body); } catch { return body; }
}
export async function waitFor(page, forKind, value, timeout = 4000) {
  return call('wait', { page, for: forKind, value: String(value), timeout }).catch(() => null);
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
