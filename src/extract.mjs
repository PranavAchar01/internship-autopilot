// Extract EVERY question from every pending form → state/pending-answers.json
// A reasoning pass (Claude session, or `claude -p` once logged in) turns that
// into state/answer-overrides.json, which genericFill consults before the
// regex question bank. Nothing is skipped for lack of a regex anymore.
import { chromium } from 'playwright-core';
import { loadProfile, loadState, saveState, log, sleep } from './lib.mjs';
import { collectFields } from './apply.mjs';
import { answerFor } from './questions.mjs';

const SUPPORTED = new Set(['greenhouse', 'lever', 'ashby']);

export async function extract() {
  const profile = loadProfile();
  const qualified = loadState('qualified', []);
  const applications = loadState('applications', []);
  const doneIds = new Set(applications.filter((a) => a.status === 'submitted').map((a) => a.id));
  const targets = qualified.filter((q) => SUPPORTED.has(q.ats) && !doneIds.has(q.id));
  log(`extract: ${targets.length} forms to read`);

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 2200 } });
  const out = [];

  const worker = async (job) => {
    const page = await ctx.newPage();
    try {
      const url = job.ats === 'lever' && !/\/apply$/.test(job.applyUrl) ? job.applyUrl.replace(/\/?$/, '/apply') : job.applyUrl;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await sleep(2500);
      const applyBtn = page.locator('button:has-text("Apply"), a:has-text("Apply Now")').first();
      if ((await page.locator('input[type="file"]').count()) === 0 && (await applyBtn.count()) > 0) {
        await applyBtn.click().catch(() => {});
        await sleep(2000);
      }
      const fields = await collectFields(page, job.ats);
      out.push({
        id: job.id, company: job.company, title: job.title, ats: job.ats, applyUrl: job.applyUrl,
        fields: fields.filter((f) => f.label).map((f) => {
          const bank = answerFor(f.label, profile, job);
          return {
            label: f.label, tag: f.tag, type: f.type || undefined, required: f.required,
            options: f.options?.slice(0, 25),
            bank: bank ? (bank.kind === 'file' ? '[file]' : bank.kind === 'cover' ? '[cover]' : bank.kind === 'skip' ? '[skip]' : String(bank.value).slice(0, 60)) : null,
          };
        }),
      });
      log(`extract: ✓ ${job.company} — ${job.title} (${fields.length} fields)`);
    } catch (e) {
      log(`extract: ✗ ${job.company} — ${String(e.message).slice(0, 100)}`);
    } finally {
      await page.close().catch(() => {});
    }
  };

  // 3-way concurrency
  const queue = [...targets];
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (queue.length) await worker(queue.shift());
  }));
  await browser.close();
  saveState('pending-answers', out);
  log(`extract: wrote state/pending-answers.json (${out.length} forms)`);
}

if (import.meta.url === `file://${process.argv[1]}`) await extract();
