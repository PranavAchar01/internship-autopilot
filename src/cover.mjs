// Cover letter generation: per-job letter (text + PDF) from resume facts.
// Template-based (honest, no invented claims); when the Claude CLI is logged
// in, apply.mjs can swap in fully tailored letters later.
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { p, log } from './lib.mjs';

// The candidate-specific paragraphs come from config/profile.yml (the `cover`
// block). Nothing about the candidate is hardcoded here — fill in your own
// `cover.opening`, `cover.ai_paragraph`, and `cover.swe_paragraph`.
export function coverText(job, profile) {
  const c = profile.candidate;
  const cv = profile.cover || {};
  const isAI = /ai|ml|data|machine/i.test(job.category || '') || /machine learning|\bai\b|\bml\b|data/i.test(job.title);
  const body = isAI ? (cv.ai_paragraph || cv.swe_paragraph || '') : (cv.swe_paragraph || cv.ai_paragraph || '');
  const links = [c.github, c.website].filter(Boolean).join(' and ');
  return `Dear ${job.company} team,

I'm writing to apply for the ${job.title} position. ${cv.opening || ''}

${body}

I'd bring that same energy to ${job.company}, and I'm confident I can contribute production-quality work from week one.${links ? ` My resume and links (${links}) have the details.` : ''} I'd welcome the chance to talk.

Sincerely,
${c.full_name}
${c.email}${c.phone ? ' · ' + c.phone : ''}`;
}

let pdfBrowser = null;
export async function coverPdf(job, profile) {
  const dir = p('data', 'covers');
  fs.mkdirSync(dir, { recursive: true });
  const file = `${dir}/${(job.company + '-' + job.id.slice(0, 8)).replace(/[^\w-]+/g, '_')}.pdf`;
  if (fs.existsSync(file)) return file;
  const text = coverText(job, profile);
  // page.pdf requires true headless — dedicated instance, reused across jobs
  if (!pdfBrowser) pdfBrowser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await pdfBrowser.newPage();
  await page.setContent(`<html><body style="font-family: Georgia, serif; font-size: 12.5px; line-height: 1.55; max-width: 640px; margin: 48px auto; white-space: pre-wrap;">${text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')}</body></html>`);
  await page.pdf({ path: file, format: 'Letter' });
  await page.close();
  log(`cover: generated ${file.split('/').pop()}`);
  return file;
}

export async function closeCoverBrowser() {
  if (pdfBrowser) { await pdfBrowser.close().catch(() => {}); pdfBrowser = null; }
}
