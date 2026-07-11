import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const p = (...xs) => path.join(ROOT, ...xs);

export function loadProfile() {
  const file = process.env.AUTOPILOT_PROFILE || p('config', 'profile.yml');
  return YAML.parse(fs.readFileSync(file, 'utf8'));
}

export function todosRemaining(profile) {
  const todos = [];
  (function walk(node, trail) {
    if (node === 'REQUIRED_TODO') todos.push(trail.join('.'));
    else if (node && typeof node === 'object')
      for (const [k, v] of Object.entries(node)) walk(v, [...trail, k]);
  })(profile, []);
  return todos;
}

export function loadState(name, fallback) {
  const f = p('state', `${name}.json`);
  if (!fs.existsSync(f)) return fallback;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

export function saveState(name, data) {
  fs.writeFileSync(p('state', `${name}.json`), JSON.stringify(data, null, 1));
}

export function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(p('logs', 'autopilot.log'), line + '\n');
}

export async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', accept: 'application/json', ...opts.headers },
    ...opts,
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const jitter = (baseMs) => baseMs * (0.75 + Math.random() * 0.5);

export function stripHtml(html) {
  return (html || '')
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── ATS URL classification ─────────────────────────────────────────────────
export function classifyAts(url) {
  const u = url.toLowerCase();
  if (u.includes('greenhouse.io')) {
    const m = url.match(/greenhouse\.io\/(?:embed\/job_app\?[^ ]*token=(\d+)|([\w-]+)\/jobs\/(\d+))/i);
    if (m) return { ats: 'greenhouse', board: m[2], jobId: m[1] || m[3] };
    return { ats: 'greenhouse' };
  }
  if (u.includes('jobs.lever.co')) {
    const m = url.match(/jobs\.lever\.co\/([\w-]+)\/([\w-]{8,})/i);
    if (m) return { ats: 'lever', board: m[1], jobId: m[2] };
    return { ats: 'lever' };
  }
  if (u.includes('ashbyhq.com')) {
    const m = url.match(/jobs\.ashbyhq\.com\/([^/]+)\/([\w-]{8,})/i);
    if (m) return { ats: 'ashby', board: decodeURIComponent(m[1]), jobId: m[2] };
    return { ats: 'ashby' };
  }
  if (u.includes('myworkdayjobs.com')) {
    const m = url.match(/https?:\/\/([\w-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[a-z]{2}\/)?([^/]+)\/job\/(.+?)(?:\?|$)/i);
    if (m) return { ats: 'workday', tenant: m[1], wd: m[2], site: m[3], jobPath: m[4] };
    return { ats: 'workday' };
  }
  if (u.includes('smartrecruiters.com')) return { ats: 'smartrecruiters' };
  if (u.includes('icims.com')) return { ats: 'icims' };
  if (u.includes('workable.com')) return { ats: 'workable' };
  if (u.includes('rippling.com')) return { ats: 'rippling' };
  return { ats: 'other' };
}

// ── JD fetchers (zero-token public APIs) ──────────────────────────────────
export async function fetchJd(listing) {
  const cls = classifyAts(listing.url);
  try {
    if (cls.ats === 'greenhouse' && cls.board && cls.jobId) {
      const j = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${cls.board}/jobs/${cls.jobId}`);
      return { ...cls, live: true, text: stripHtml(j.content), applyUrl: j.absolute_url };
    }
    if (cls.ats === 'lever' && cls.board && cls.jobId) {
      const j = await fetchJson(`https://api.lever.co/v0/postings/${cls.board}/${cls.jobId}`);
      return { ...cls, live: true, text: stripHtml(j.description + ' ' + (j.lists || []).map(l => l.text + ' ' + stripHtml(l.content)).join(' ')), applyUrl: j.applyUrl || `${j.hostedUrl}/apply` };
    }
    if (cls.ats === 'ashby' && cls.board) {
      const j = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(cls.board)}?includeCompensation=true`);
      const job = (j.jobs || []).find(x => x.id === cls.jobId || (x.jobUrl || '').includes(cls.jobId));
      if (!job) return { ...cls, live: false };
      return { ...cls, live: true, text: stripHtml(job.descriptionHtml || job.descriptionPlain), applyUrl: job.applyUrl || job.jobUrl + '/application' };
    }
    if (cls.ats === 'workday' && cls.tenant) {
      const j = await fetchJson(`https://${cls.tenant}.${cls.wd}.myworkdayjobs.com/wday/cxs/${cls.tenant}/${cls.site}/job/${cls.jobPath}`);
      const info = j.jobPostingInfo;
      if (!info) return { ...cls, live: false };
      return { ...cls, live: true, text: stripHtml(info.jobDescription), applyUrl: listing.url };
    }
  } catch (e) {
    if (String(e.message).startsWith('404')) return { ...cls, live: false };
    return { ...cls, live: null, error: e.message };
  }
  return { ...cls, live: null, text: null };
}
