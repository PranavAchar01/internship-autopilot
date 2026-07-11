// Drive ONE application end-to-end in BrowserOS. Usage:
//   BOS_MCP=http://127.0.0.1:9000/mcp node applyone.mjs <jobId|url> [--submit]
import * as bos from './src/bos.mjs';
import { fillForm } from './src/fill-bos.mjs';
import { loadProfile, loadState } from './src/lib.mjs';
import { coverPdf, closeCoverBrowser } from './src/cover.mjs';
import fs from 'node:fs';

const arg = process.argv[2];
const doSubmit = process.argv.includes('--submit');
const profile = loadProfile();
const pool = loadState('qualified', []).concat(loadState('review', []));
const job = pool.find((x) => x.id === arg || x.applyUrl === arg || x.url === arg) ||
  { id: 'jump-test', company: 'Jump Trading', ats: 'greenhouse', category: 'AI/ML/Data', terms: ['Fall 2026'], title: 'Campus UI SWE Intern', applyUrl: arg && arg.startsWith('http') ? arg : 'https://boards.greenhouse.io/embed/job_app?token=8003019' };

await bos.init();
job._coverPdf = await coverPdf(job, profile).catch(() => null);
await closeCoverBrowser();

const url = job.ats === 'lever' && !/\/apply$/.test(job.applyUrl || '') ? (job.applyUrl || '').replace(/\/?$/, '/apply') : (job.applyUrl || job.url);
const page = await bos.newTab(url);
await bos.sleep(4500);

const r = await fillForm(page, job, profile);
console.log(`FILL — filled ${r.filled}, missing: ${JSON.stringify(r.missing)}`);

// screenshot proof
try {
  const s = await bos.call('screenshot', { page, fullPage: true });
  const img = (s.raw?.content || []).find((c) => c.type === 'image');
  if (img?.data) { fs.writeFileSync(`logs/bos-${job.id}.png`, Buffer.from(img.data, 'base64')); console.log(`screenshot: logs/bos-${job.id}.png`); }
} catch {}

if (doSubmit && r.missing.length === 0) {
  console.log('SUBMIT: all required filled — clicking submit');
  const snap = await bos.snapshot(page);
  const btn = snap.split('\n').find((l) => /button "Submit/i.test(l));
  if (btn) {
    const ref = btn.match(/\[ref=(e\d+)\]/)?.[1];
    await bos.act(page, { kind: 'click', ref });
    await bos.sleep(4000);
    const after = await bos.read(page, 'text').catch(() => '');
    const ok = /thank|submitted|received|verification code/i.test(after);
    console.log('post-submit page signal:', ok ? 'confirmation-or-verification-step' : 'unclear (inspect screenshot)');
    try { const s2 = await bos.call('screenshot', { page, fullPage: true }); const im = (s2.raw?.content || []).find((c) => c.type === 'image'); if (im?.data) fs.writeFileSync(`logs/bos-${job.id}-after.png`, Buffer.from(im.data, 'base64')); } catch {}
  } else console.log('no Submit button found');
} else if (doSubmit) {
  console.log(`SUBMIT skipped — ${r.missing.length} required fields unfilled (would not submit incomplete)`);
}
console.log('tab left open:', page);
