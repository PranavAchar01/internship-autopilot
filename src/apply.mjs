// Stage 3 — APPLY: drives real application forms (Greenhouse, Lever, Ashby)
// with Playwright on system Chrome. Generic label-driven filler + question
// bank. Guarantees:
//   • never submits unless apply.live === true AND no REQUIRED_TODO remains
//   • never guesses: unmapped required fields → review queue, not a guess
//   • CAPTCHA present → review queue
//   • respects daily cap + jitter between applications
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { loadProfile, loadState, saveState, todosRemaining, log, sleep, jitter, p } from './lib.mjs';
import { answerFor, pickOption } from './questions.mjs';
import { applyWorkday } from './ats/workday.mjs';
import { coverPdf, coverText, closeCoverBrowser } from './cover.mjs';
import { pickFromDropdown } from './dropdown.mjs';

// Greenhouse + Lever submit reliably headless. Ashby spam-flags headless
// submits server-side, and Workday's multi-page wizard is fragile — both are
// routed straight to the manual review queue instead of burning attempts.
const SUPPORTED = new Set(['greenhouse', 'lever']);
const ROUTE_TO_REVIEW = { ashby: 'ashby_antibot_use_manual', workday: 'workday_use_manual' };

function today() { return new Date().toISOString().slice(0, 10); }

export async function collectFields(page, ats = '') {
  // Every fillable control with its best-effort label + required flag.
  return page.evaluate((ats) => {
    const seen = new Set();
    const out = [];
    const labelFor = (el) => {
      let t = '';
      if (el.id) t = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent || '';
      if (!t) t = el.getAttribute('aria-label') || '';
      if (!t && el.getAttribute('aria-labelledby'))
        t = el.getAttribute('aria-labelledby').split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent || '').join(' ');
      if (!t) t = el.closest('label')?.textContent || '';
      if (!t) {
        const wrap = el.closest('div,fieldset,li');
        t = wrap?.querySelector('label, legend, .label, [class*="label" i]')?.textContent || '';
      }
      // Lever puts the question text in .application-label, a sibling of the
      // input's container
      if (!t) t = el.closest('.application-question')?.querySelector('.application-label')?.textContent || '';
      if (!t) t = el.placeholder || el.name || '';
      return t.replace(/\s+/g, ' ').trim().slice(0, 220);
    };
    // Required-ness can live in: the required attr, aria-required, a literal
    // asterisk in the label text, a "required" class on the label element, or
    // an asterisk rendered as CSS ::after pseudo-content (Ashby).
    const labelElOf = (el, qId = null) => {
      if (qId) { const l = document.querySelector(`label[for="${CSS.escape(qId)}"]`); if (l) return l; }
      if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return l; }
      return el.closest('div,fieldset,li')?.querySelector('label,legend') || null;
    };
    const req = (el, label, labelEl = null) => {
      if (el.required || el.getAttribute('aria-required') === 'true' || /[*✱]|\brequired\b/i.test(label)) return true;
      const le = labelEl || labelElOf(el);
      return !!le && (/(^|[_\s-])required/i.test(le.className) || (getComputedStyle(le, '::after').content || '').includes('*'));
    };
    for (const el of document.querySelectorAll('input, textarea, select')) {
      if (['hidden', 'submit', 'button'].includes(el.type)) continue;
      // react-select renders a hidden, label-less mirror input (class
      // "…-requiredInput") purely to carry the select's value for HTML5
      // required-validation. It is NOT a question — the real dropdown is
      // captured separately. Skipping it removes the phantom "(unlabeled
      // input)" that was blocking otherwise-complete forms.
      if (String(el.className).includes('requiredInput')) continue;
      // radio/checkbox/file inputs are routinely visually hidden behind
      // styled labels (Ashby, Greenhouse new UI) — never skip them for that
      if (el.disabled || (el.offsetParent === null && !['file', 'radio', 'checkbox'].includes(el.type))) continue;
      // A react-select search input IS the dropdown control — capture it as a
      // combobox (typeable), and remember its label so the container-div loop
      // below doesn't double-count the same question.
      const isRS = el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') === 'list';
      const key = el.name + '|' + el.id + '|' + el.type;
      // Ashby yes/no button-pair widgets keep a hidden checkbox — handled below
      if ((el.type === 'checkbox' || el.type === 'radio') && el.closest('[class*="yesno" i]')) continue;
      if (el.type === 'radio' || el.type === 'checkbox') {
        if (seen.has('grp|' + el.name)) continue;
        seen.add('grp|' + el.name);
        const group = [...document.querySelectorAll(`input[name="${CSS.escape(el.name)}"]`)];
        const fieldWrap = el.closest('fieldset,[role="group"],div[class*="question" i],div[class*="field" i]') || el.closest('div');
        // Ashby: radio name is "{form}_{questionId}" and the question's label
        // is label[for="{questionId}"]
        const qId = el.name.includes('_') ? el.name.split('_').pop() : null;
        const qLabelEl = (qId && document.querySelector(`label[for="${CSS.escape(qId)}"]`)) ||
          el.closest('.application-question')?.querySelector('.application-label') ||
          fieldWrap?.querySelector('legend,[class*="label" i],label') || null;
        const legend = (qLabelEl?.textContent || labelFor(el)).replace(/\s+/g, ' ').trim().slice(0, 220);
        out.push({ tag: 'group', type: el.type, name: el.name, label: legend, required: req(el, legend, qLabelEl),
          options: group.map((g) => (g.labels?.[0]?.textContent || g.closest('label')?.textContent || g.value).replace(/\s+/g, ' ').trim()),
          empty: !group.some((g) => g.checked) });
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      const label = labelFor(el);
      if (isRS) {
        // react-select: the chosen value renders in a sibling, NOT el.value
        const control = el.closest('[class*="control" i], [class*="ValueContainer" i]') || el.parentElement;
        const chosen = control?.querySelector('[class*="singleValue" i], [class*="multiValue" i]')?.textContent || '';
        if (label) seen.add('cb|' + label); // block the container-div loop from re-adding
        out.push({ tag: 'combobox', type: 'text', name: el.name || '', id: el.id || '', label,
          required: req(el, label), autocomplete: true,
          empty: !chosen.trim() });
        continue;
      }
      const item = { tag: el.tagName.toLowerCase(), type: el.type || '', name: el.name || '', id: el.id || '',
        label, required: req(el, label), value: el.value || '',
        role: el.getAttribute('role') || '', autocomplete: !!el.getAttribute('aria-autocomplete') };
      if (item.tag === 'select') item.options = [...el.options].map((o) => o.textContent.trim()).filter(Boolean);
      item.empty = el.type === 'file'
        ? el.files.length === 0 && !el.closest('div')?.textContent?.includes('.pdf')
        : !(el.value || '').trim() || (item.tag === 'select' && el.selectedIndex <= 0 && !(el.options[0]?.value || '').trim());
      out.push(item);
    }
    // custom comboboxes (Greenhouse/Ashby react-selects) not backed by an input
    for (const el of document.querySelectorAll('[role="combobox"]:not(input):not(select)')) {
      const label = labelFor(el);
      if (!label || seen.has('cb|' + label)) continue;
      seen.add('cb|' + label);
      out.push({ tag: 'combobox', label, required: req(el, label), id: el.id || '',
        empty: !(el.textContent || '').trim() || /select|choose|type here|start typing/i.test(el.textContent) });
    }
    // Ashby yes/no button pairs: two <button>s + hidden checkbox; selection
    // is marked by an "_active_" class on the chosen button
    for (const el of document.querySelectorAll('[class*="yesno" i]')) {
      const btns = [...el.querySelectorAll('button')];
      if (btns.length < 2) continue;
      const name = el.querySelector('input')?.name || '';
      if (!name || seen.has('yn|' + name)) continue;
      seen.add('yn|' + name);
      const lblEl = document.querySelector(`label[for="${CSS.escape(name)}"]`);
      const label = (lblEl?.textContent || labelFor(el)).replace(/\s+/g, ' ').trim().slice(0, 220);
      out.push({ tag: 'yesnobtn', name, label, required: req(el, label, lblEl),
        options: btns.map((b) => b.textContent.trim()),
        empty: !btns.some((b) => /active|selected|checked/i.test(b.className)) });
    }
    // Workday-style dropdowns: <button aria-haspopup="listbox">
    for (const el of document.querySelectorAll('button[aria-haspopup="listbox"]')) {
      const label = labelFor(el);
      if (!label || seen.has('wd|' + label)) continue;
      seen.add('wd|' + label);
      out.push({ tag: 'wdselect', label, required: req(el, label), id: el.id || '',
        empty: /select one|^\s*$/i.test((el.textContent || '').trim()) });
    }
    // ARIA widget radio/checkbox groups (Ashby renders these, not <input>s)
    const ariaSeen = new Set();
    for (const el of document.querySelectorAll('[role="radio"], [role="checkbox"]')) {
      if (el.tagName === 'INPUT') continue;
      const wrap = el.closest('[role="radiogroup"],[role="group"],fieldset') || el.parentElement?.closest('div');
      if (!wrap) continue;
      const members = [...wrap.querySelectorAll('[role="radio"], [role="checkbox"]')];
      const label = labelFor(wrap) ||
        (wrap.closest('div,fieldset')?.querySelector('label,legend,[class*="label" i]')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 220);
      if (ariaSeen.has('ag|' + label)) continue;  // dedupe by question, not wrapper node
      ariaSeen.add('ag|' + label);
      out.push({ tag: 'ariagroup', label, required: req(wrap, label),
        options: members.map((m) => (m.getAttribute('aria-label') || m.textContent || '').replace(/\s+/g, ' ').trim()),
        empty: !members.some((m) => m.getAttribute('aria-checked') === 'true') });
    }
    return out;
  }, ats);
}

function fieldLocator(page, f) {
  if (f.id) return page.locator(`[id="${f.id}"]`).first();
  if (f.name) return page.locator(`[name="${f.name}"]`).first();
  return page.getByLabel(f.label, { exact: false }).first();
}

async function fillField(page, f, ans) {
  const loc = fieldLocator(page, f);
  try {
    if (ans.kind === 'file') {
      // use THIS field's input — .first() would dump every file into the resume slot
      const target = f.type === 'file' && (f.id || f.name) ? loc : page.locator('input[type="file"]').first();
      await target.setInputFiles(ans.value);
      return true;
    }
    if (ans.kind === 'date') {
      // month/year date parts on dropdowns; full string on text inputs.
      // A single "expected graduation date" dropdown lists terms like
      // "Spring/Summer 2029" — match on the YEAR so it lands regardless of
      // the term wording (and honestly fails if their list stops before it).
      if (['select', 'wdselect', 'combobox'].includes(f.tag) || f.autocomplete) {
        const season = /jan|feb|mar|apr|may/i.test(ans.month) ? 'spring|summer'
          : /jun|jul|aug/i.test(ans.month) ? 'summer|fall' : 'fall|winter|autumn';
        ans = { kind: 'option', value: /month/i.test(f.label) ? ans.month : /year/i.test(f.label) ? ans.year : ans.year,
          prefer: /month|year/i.test(f.label) ? null : season };
      } else ans = { kind: 'text', value: ans.value };
    }
    if (f.tag === 'yesnobtn') {
      const choice = pickOption(ans.kind === 'consent' ? { kind: 'bool', value: 'Yes' } : ans, f.options || []);
      if (!choice) return false;
      await page.locator(`[class*="yesno" i]:has(input[name="${f.name}"]) >> button:has-text("${choice}")`).first().click();
      return true;
    }
    if (f.tag === 'select') {
      const choice = pickOption(ans, f.options || []);
      if (!choice) return false;
      await loc.selectOption({ label: choice });
      return true;
    }
    if (f.tag === 'group') {
      const choice = pickOption(ans.kind === 'consent' ? { kind: 'bool', value: 'Yes' } : ans, f.options || []);
      if (ans.kind === 'consent' && f.type === 'checkbox') { await page.locator(`input[name="${f.name}"]`).first().check(); return true; }
      if (!choice) return false;
      const idx = f.options.indexOf(choice);
      const input = page.locator(`input[name="${f.name}"]`).nth(idx);
      try { await input.check({ force: true, timeout: 4000 }); }
      catch { // hidden input: click its styled label instead
        const byRole = page.getByRole(f.type === 'radio' ? 'radio' : 'checkbox', { name: choice, exact: false }).first();
        if (await byRole.count()) await byRole.click({ force: true });
        else await page.locator(`label:has(input[name="${f.name}"])`).nth(idx).click();
      }
      return true;
    }
    if (f.tag === 'ariagroup') {
      const choice = pickOption(ans.kind === 'consent' ? { kind: 'bool', value: 'Yes' } : ans, f.options || []);
      if (!choice) return false;
      // scope the click to THIS question's container — a bare getByRole
      // matches the first same-named option anywhere on the page
      const scope = page.locator('fieldset, [role="radiogroup"], [role="group"]')
        .filter({ hasText: f.label.slice(0, 60) }).last();
      const container = (await scope.count()) ? scope : page;
      const radio = container.getByRole('radio', { name: choice, exact: false }).first();
      if (await radio.count()) await radio.click();
      else {
        const cb = container.getByRole('checkbox', { name: choice, exact: false }).first();
        if (await cb.count()) await cb.click();
        else await container.locator(`label:has-text("${choice}")`).last().click();
      }
      return true;
    }
    if (ans.kind === 'cover') {
      if (f.type === 'file') { await loc.setInputFiles(ans.file); return true; }
      await loc.fill(ans.text);
      return true;
    }
    if (f.tag === 'wdselect' || f.tag === 'combobox' || f.autocomplete || ans.kind === 'autocomplete' || ans.kind === 'option' || ans.kind === 'decline') {
      return pickFromDropdown(page, loc, f, ans);
    }
    if (f.type === 'checkbox') { if (ans.kind === 'consent' || ans.value === 'Yes') { await loc.check(); return true; } return false; }
    await loc.fill(String(ans.value));
    // React-controlled inputs sometimes swallow fill(); retype for real
    if (!(await loc.inputValue().catch(() => 'x'))) {
      await loc.click();
      await loc.pressSequentially(String(ans.value), { delay: 5 });
    }
    return true;
  } catch {
    return false;
  }
}

// Per-job reasoned answers (state/answer-overrides.json), authored by a
// Claude pass over state/pending-answers.json. Highest precedence.
function overrideFor(job, label) {
  const all = loadState('answer-overrides', {});
  const forJob = all[job.id];
  if (!forJob) return null;
  if (forJob[label]) return forJob[label];
  // tolerate whitespace/asterisk drift between extraction and fill time
  const norm = (s) => s.toLowerCase().replace(/[*✱]/g, '').replace(/\s+/g, ' ').trim();
  const hit = Object.keys(forJob).find((k) => norm(k) === norm(label));
  return hit ? forJob[hit] : null;
}

// Fill everything answerable on the current page; return { missing, filled }
// where missing includes the post-fill verification (required + still empty).
export async function genericFill(page, job, profile) {
  const fields = await collectFields(page, job.ats);
  const missing = [];
  let filled = 0;
  for (const f of fields) {
    // File inputs: map by id/label to resume vs cover, never by the button
    // text ("Attach") that labelFor often grabs. The resume is the single
    // most important attachment — it must never be silently skipped.
    if (f.type === 'file') {
      const key = `${f.id} ${f.name} ${f.label}`.toLowerCase();
      if (/cover/.test(key)) {
        if (job._coverPdf) { if (await fillField(page, f, { kind: 'file', value: job._coverPdf })) filled++; }
        continue; // cover optional → skip if none
      }
      if (/transcript/.test(key)) {
        if (profile.candidate.transcript_pdf) { if (await fillField(page, f, { kind: 'file', value: profile.candidate.transcript_pdf })) filled++; }
        else if (f.required) missing.push('Transcript upload (none on file)');
        continue;
      }
      // default: resume
      const ok = await fillField(page, f, { kind: 'file', value: profile.candidate.resume_pdf });
      if (ok) filled++; else missing.push('Resume upload failed');
      await sleep(jitter(400));
      continue;
    }
    if (!f.label) { if (f.required) missing.push(`(unlabeled ${f.tag})`); continue; }
    const ans = overrideFor(job, f.label) || answerFor(f.label, profile, job);
    if (!ans || ans.kind === 'skip') {
      if (f.required) missing.push(f.label);
      continue;
    }
    if (f.empty === false && f.tag !== 'group' && f.tag !== 'ariagroup') { filled++; continue; } // already has a value
    const ok = await fillField(page, f, ans);
    if (ok) filled++;
    else if (f.required) missing.push(f.label);
    await sleep(jitter(250));
  }
  await sleep(800);
  const verify = await collectFields(page, job.ats);
  for (const vf of verify) {
    if (vf.required && vf.empty && vf.label && !missing.includes(vf.label)) missing.push(`${vf.label} [post-check empty]`);
  }
  return { missing, filled };
}

async function hasCaptcha(page) {
  // Only VISIBLE challenge widgets block submission. Invisible reCAPTCHA v3
  // badges (src contains size=invisible) are on every Greenhouse form and are
  // handled server-side — they are not blockers.
  return page.evaluate(() => {
    for (const f of document.querySelectorAll('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"]')) {
      const src = f.getAttribute('src') || '';
      if (src.includes('size=invisible')) continue;
      const r = f.getBoundingClientRect();
      if (r.width >= 100 && r.height >= 60 && f.offsetParent !== null) return true;
    }
    return false;
  });
}

export async function applyBatch({ dryOverride = null, limit = null } = {}) {
  // single-instance lock — a scheduled run and a manual run must not overlap
  const LOCK = p('state', 'apply.lock');
  if (fs.existsSync(LOCK)) {
    const pid = Number(fs.readFileSync(LOCK, 'utf8'));
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch {}
    if (alive) { log(`apply: another apply run (pid ${pid}) is active — skipping`); return; }
  }
  fs.writeFileSync(LOCK, String(process.pid));

  const profile = loadProfile();
  const todos = todosRemaining(profile);
  // The REQUIRED_TODO gate is absolute: no flag can force live submission
  // while legal-attestation answers are missing from profile.yml.
  let live = dryOverride === null ? profile.apply.live : !dryOverride;
  if (live && todos.length) {
    log(`apply: LIVE blocked — unfilled REQUIRED_TODO: ${todos.join(', ')} — running dry`);
    live = false;
  }

  const qualified = loadState('qualified', []);
  const applications = loadState('applications', []);
  const review = loadState('review', []);
  const doneIds = new Set([...applications.map((a) => a.id), ...review.map((r) => r.id)]);
  const submittedToday = applications.filter((a) => a.date === today() && a.status === 'submitted').length;
  let budget = Math.max(0, (limit ?? profile.apply.daily_cap) - (live ? submittedToday : 0));

  const targets = qualified.filter((q) => !doneIds.has(q.id));
  if (!targets.length || !budget) { log(`apply: nothing to do (targets=${targets.length}, budget=${budget})`); return; }

  // headful (visible window) defeats the server-side bot heuristics that
  // spam-flag headless submissions on some Ashby boards
  const browser = await chromium.launch({
    channel: 'chrome', headless: profile.apply.headful !== true,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1366, height: 2200 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
  });
  log(`apply: mode=${live ? 'LIVE' : 'DRY-RUN'}, budget=${budget}, targets=${targets.length}`);

  for (const job of targets) {
    if (budget <= 0) break;
    if (doneIds.has(job.id)) continue;
    if (!SUPPORTED.has(job.ats)) {
      review.push({ ...job, reason: ROUTE_TO_REVIEW[job.ats] || `ats_unsupported:${job.ats}`, queuedAt: new Date().toISOString() });
      doneIds.add(job.id);
      saveState('review', review);
      continue;
    }
    const page = await ctx.newPage();
    const slug = `${job.company}-${job.id.slice(0, 8)}`.replace(/[^\w-]+/g, '_');
    try {
      if (job.ats === 'workday') {
        const shot = p('logs', `${today()}-${slug}.png`);
        const r = await applyWorkday(page, job, profile, {
          live,
          genericFill: (pg, jb) => genericFill(pg, jb, profile).then((x) => x.missing),
          pickOption,
          screenshotPath: shot,
        });
        await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
        if (r.status === 'submitted') {
          applications.push({ id: job.id, date: today(), company: job.company, title: job.title, url: job.url, ats: 'workday', status: 'submitted', screenshot: shot });
          log(`apply: SUBMITTED (workday) ${job.company} — ${job.title}`);
          budget--;
          await sleep(jitter(profile.apply.min_seconds_between * 1000));
        } else if (r.status === 'dry_run') {
          applications.push({ id: job.id, date: today(), company: job.company, title: job.title, url: job.url, ats: 'workday', status: 'dry_run', screenshot: shot });
          log(`apply: DRY-RUN ok (workday) ${job.company} — ${r.reason}`);
          budget--;
        } else {
          review.push({ ...job, reason: r.reason, missing: r.missing, screenshot: shot, queuedAt: new Date().toISOString() });
          log(`apply: → review (workday) ${job.company} — ${r.reason}${r.missing ? ': ' + r.missing.slice(0, 3).join(' | ') : ''}`);
        }
        doneIds.add(job.id);
        continue;
      }
      job._coverText = coverText(job, profile);
      job._coverPdf = await coverPdf(job, profile).catch(() => null);
      const url = job.ats === 'lever' && !/\/apply$/.test(job.applyUrl) ? job.applyUrl.replace(/\/?$/, '/apply') : job.applyUrl;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await sleep(2500);
      // Greenhouse new UI sometimes needs the Apply tab clicked
      const applyBtn = page.locator('button:has-text("Apply"), a:has-text("Apply Now")').first();
      if ((await page.locator('input[type="file"]').count()) === 0 && (await applyBtn.count()) > 0) {
        await applyBtn.click().catch(() => {});
        await sleep(2000);
      }

      const fields = await collectFields(page, job.ats);
      if (!fields.length) throw new Error('no form fields found');
      const { missing, filled } = await genericFill(page, job, profile);
      const captcha = await hasCaptcha(page);
      const shot = p('logs', `${today()}-${slug}.png`);
      if (profile.apply.screenshot_every_app) await page.screenshot({ path: shot, fullPage: true }).catch(() => {});

      if (missing.length || captcha) {
        review.push({ ...job, reason: captcha ? 'captcha' : 'unanswerable_required', missing, screenshot: shot, queuedAt: new Date().toISOString() });
        log(`apply: → review ${job.company} — ${captcha ? 'CAPTCHA' : 'missing: ' + missing.slice(0, 4).join(' | ')}`);
      } else if (!live) {
        applications.push({ id: job.id, date: today(), company: job.company, title: job.title, url: job.applyUrl, ats: job.ats, status: 'dry_run', filled, screenshot: shot });
        log(`apply: DRY-RUN ok ${job.company} — ${job.title} (${filled} fields filled, would submit)`);
        budget--;
      } else {
        const submit = page.locator('button[type="submit"]:visible, button:has-text("Submit application"), button:has-text("Submit Application"), input[type="submit"]').first();
        await submit.click();
        await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
        await sleep(3000);
        const challenge = await hasCaptcha(page); // v2/hCaptcha challenge popped after submit
        const confirmed = !challenge && await page.locator("text=/thank(s| you)|application (was )?(submitted|received)|we have received/i").count() > 0;
        if (challenge) {
          review.push({ ...job, reason: 'captcha_after_submit', queuedAt: new Date().toISOString() });
          log(`apply: → review ${job.company} — captcha challenge after submit`);
          doneIds.add(job.id);
          await page.close().catch(() => {});
          saveState('review', review);
          continue;
        }
        const shot2 = p('logs', `${today()}-${slug}-confirm.png`);
        await page.screenshot({ path: shot2, fullPage: true }).catch(() => {});
        // Backstops: ATS validation errors or spam-flag rejection → review.
        // Without POSITIVE confirmation text we never claim a submission.
        const rejected = await page.locator("text=/flagged as (possible )?spam|couldn't submit|unable to submit|submission (was )?(rejected|blocked)/i").count() > 0;
        const validationErr = await page.locator('text=/is required|please (select|complete|fill|enter)|field is required/i').count() > 0;
        if (rejected || (!confirmed && validationErr)) {
          review.push({ ...job, reason: rejected ? 'flagged_as_spam' : 'submit_validation_failed', screenshot: shot2, queuedAt: new Date().toISOString() });
          log(`apply: → review ${job.company} — ${rejected ? 'submission flagged as spam' : 'ATS validation rejected submit'}`);
          doneIds.add(job.id);
          continue;
        }
        if (!confirmed) {
          review.push({ ...job, reason: 'submit_unverified', screenshot: shot2, queuedAt: new Date().toISOString() });
          log(`apply: → review ${job.company} — no submit confirmation found (verify manually)`);
          doneIds.add(job.id);
          continue;
        }
        applications.push({ id: job.id, date: today(), company: job.company, title: job.title, url: job.applyUrl, ats: job.ats,
          status: 'submitted', filled, screenshot: shot2 });
        log(`apply: SUBMITTED ${job.company} — ${job.title}`);
        budget--;
        await sleep(jitter(profile.apply.min_seconds_between * 1000));
      }
      doneIds.add(job.id);
    } catch (e) {
      review.push({ ...job, reason: `error: ${String(e.message).slice(0, 140)}`, queuedAt: new Date().toISOString() });
      doneIds.add(job.id);
      log(`apply: ✗ ${job.company} — ${String(e.message).slice(0, 120)}`);
    } finally {
      await page.close().catch(() => {});
      saveState('applications', applications);
      saveState('review', review);
    }
  }
  await browser.close();
  await closeCoverBrowser();
  fs.unlinkSync(p('state', 'apply.lock'));
  log(`apply: done — submitted total today=${applications.filter((a) => a.date === today() && a.status.startsWith('submitted')).length}, review queue=${review.length}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dry = process.argv.includes('--dry') ? true : process.argv.includes('--live') ? false : null;
  const lim = process.argv.find((a) => a.startsWith('--limit='));
  await applyBatch({ dryOverride: dry, limit: lim ? Number(lim.split('=')[1]) : null });
}
