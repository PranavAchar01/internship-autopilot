// Workday adapter: per-tenant account creation + the multi-page application
// wizard. Workday uses stable data-automation-id attributes, which makes it
// the most automatable of the big proprietary ATSes.
//
// Outcomes: { status: 'submitted' | 'dry_run' | 'review', reason?, missing? }
// Anything unexpected (email verification demanded, persistent validation
// errors, unknown page) → review, never a blind submit.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { p, log, sleep, jitter } from '../lib.mjs';
import { pickFromDropdown } from '../dropdown.mjs';

const CRED_FILE = p('state', 'credentials.json');

function creds(tenant, email) {
  const all = fs.existsSync(CRED_FILE) ? JSON.parse(fs.readFileSync(CRED_FILE, 'utf8')) : {};
  if (!all[tenant]) {
    // meets Workday complexity rules: upper/lower/digit/special, 16 chars
    const password = 'Wd!' + crypto.randomBytes(12).toString('base64').replace(/[+/=]/g, 'x') + '7a';
    all[tenant] = { email, password, created: new Date().toISOString() };
    fs.writeFileSync(CRED_FILE, JSON.stringify(all, null, 1), { mode: 0o600 });
    log(`workday: generated credentials for tenant ${tenant}`);
  }
  return all[tenant];
}

const aid = (page, id) => page.locator(`[data-automation-id="${id}"]`).first();

// Workday overlays real <button>s with a click_filter div (role=button,
// aria-label) that intercepts pointer events — click via role/aria first.
async function wdClick(page, label, fallbackLoc = null) {
  const byRole = page.getByRole('button', { name: label, exact: false }).first();
  if (await byRole.count()) { await byRole.click({ timeout: 8000 }); return true; }
  const loc = fallbackLoc || page.locator(`button:has-text("${label}")`).first();
  if (!(await loc.count())) return false;
  try { await loc.click({ timeout: 5000 }); } catch { await loc.click({ force: true }); }
  return true;
}
const vis = async (l) => (await l.count()) > 0 && (await l.first().isVisible().catch(() => false));

async function clickIfVisible(page, id) {
  const l = aid(page, id);
  if (await vis(l)) { await l.click(); return true; }
  return false;
}

// Workday <button aria-haspopup="listbox"> dropdown
async function wdSelect(page, button, ans, pickOption) {
  await button.click();
  await sleep(600);
  const opts = page.locator('[role="option"]:visible, ul[role="listbox"] li:visible');
  const n = await opts.count();
  if (!n) { await page.keyboard.press('Escape'); return false; }
  const texts = [];
  for (let i = 0; i < Math.min(n, 40); i++) texts.push((await opts.nth(i).innerText()).trim());
  const choice = pickOption(ans, texts);
  if (!choice) { await page.keyboard.press('Escape'); return false; }
  await opts.nth(texts.indexOf(choice)).click();
  await sleep(400);
  return true;
}

// Selector-agnostic: create-account forms have 2 visible password inputs,
// sign-in forms have 1. Tenant-specific automation-ids vary; input types don't.
async function authenticate(page, tenant, profile) {
  const c = creds(tenant, profile.candidate.email);
  const pwds = page.locator('input[type="password"]:visible');
  const emailInput = page.locator('input[type="text"]:visible, input[type="email"]:visible').first();
  const nPwd = await pwds.count();
  if (!nPwd) return { ok: true };

  if (await emailInput.count()) { await emailInput.fill(''); await emailInput.fill(c.email); }
  await pwds.nth(0).fill(c.password);
  if (nPwd >= 2) {
    // create account
    await pwds.nth(1).fill(c.password);
    const acceptBox = page.locator('input[type="checkbox"]:visible').first();
    if (await acceptBox.count()) await acceptBox.check({ force: true }).catch(() => {});
    else await page.locator('label:has-text("I accept"), [data-automation-id="createAccountCheckbox"]').first().click().catch(() => {});
    await wdClick(page, 'Create Account');
    await sleep(4000);
    const errTexts = await page.locator('[data-automation-id="errorMessage"], [role="alert"]').allInnerTexts().catch(() => []);
    if (errTexts.length) log(`workday auth: post-create errors: ${errTexts.join(' | ').slice(0, 200)}`);
    if (await page.locator('text=/already (exists|in use|have an account)/i').count()) {
      // existing account → switch to sign-in; our stored password may be wrong
      await page.locator('a:has-text("Sign In"), [data-automation-id="signInLink"]').first().click().catch(async () => { await wdClick(page, 'Sign In'); });
      await sleep(2000);
      const p2 = page.locator('input[type="password"]:visible');
      if (await p2.count()) {
        const e2 = page.locator('input[type="text"]:visible, input[type="email"]:visible').first();
        if (await e2.count()) { await e2.fill(''); await e2.fill(c.email); }
        await p2.first().fill(c.password);
        await wdClick(page, 'Sign In');
        await sleep(4000);
        if (await page.locator('text=/invalid|incorrect|does ?n.t match/i').count())
          return { ok: false, reason: 'workday_existing_account_unknown_password' };
      }
    }
  } else {
    // sign in
    await wdClick(page, 'Sign In');
    await sleep(4000);
    if (await page.locator('text=/invalid|incorrect|does ?n.t match/i').count())
      return { ok: false, reason: 'workday_existing_account_unknown_password' };
  }
  if (await page.locator('text=/verify your email|verification code|check your (inbox|email)/i').count())
    return { ok: false, reason: 'workday_email_verification_required' };
  return { ok: true };
}

async function fillMyInformation(page, profile, pickOption) {
  const c = profile.candidate;
  const F = async (id, val) => { const l = aid(page, id); if (await vis(l) && !(await l.inputValue().catch(() => 'x'))) await l.fill(val); };
  await F('legalNameSection_firstName', c.first_name);
  await F('legalNameSection_lastName', c.last_name);
  await F('addressSection_addressLine1', c.street_address);
  await F('addressSection_city', c.city);
  await F('addressSection_postalCode', c.zip);
  await F('phone-number', c.phone.replace(/[^\d]/g, ''));
  for (const [id, ans] of [
    ['countryDropdown', { kind: 'option', value: 'United States of America', fallback: 'United States' }],
    ['addressSection_countryRegion', { kind: 'option', value: c.state }],
    ['phone-device-type', { kind: 'option', value: 'Mobile', fallback: 'Cell' }],
  ]) {
    const b = aid(page, id);
    if (await vis(b) && (await b.evaluate((el) => el.tagName === 'BUTTON').catch(() => false)))
      await wdSelect(page, b, ans, pickOption).catch(() => {});
  }
  // "How did you hear about us?" — Workday nested multiselect prompt.
  // NEVER type into it: the top level is categories (Job Board / Career Fair
  // / Other / …) that must be clicked through to a leaf.
  const src = page.locator('[data-automation-id="sourceSection"] input, [data-automation-id="multiselectInputContainer"] input').first();
  if ((await src.count()) && (await src.isVisible().catch(() => false))) {
    const alreadyPicked = await page.locator('[data-automation-id="sourceSection"] [data-automation-id="selectedItem"]').count();
    if (!alreadyPicked) {
      await pickFromDropdown(page, src, { label: 'How did you hear about us?', tag: 'combobox' },
        { kind: 'option', value: 'Job Board', fallback: 'Other' });
    }
  }
  // "previously worked for X?" radio pair — click the No label inside the group
  const prevGroup = page.locator('fieldset:has-text("previously worked"), [role="group"]:has-text("previously worked"), [data-automation-id*="previousWorker"]').last();
  if ((await prevGroup.count()) && (await prevGroup.isVisible().catch(() => false))) {
    await prevGroup.locator('label:has-text("No")').last().click().catch(() => {});
    await sleep(400);
  }
}

async function pageErrors(page) {
  if (!(await page.locator('[data-automation-id="errorBanner"]').count())) return [];
  const msgs = await page.locator('[data-automation-id="errorMessage"], [data-automation-id="fieldError"]').allInnerTexts().catch(() => []);
  return msgs.length ? msgs : ['validation error'];
}

export async function applyWorkday(page, job, profile, { live, genericFill, pickOption, screenshotPath }) {
  const tenant = job.tenant || new URL(job.url).hostname.split('.')[0];
  await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await sleep(2000);

  // cookie banner
  await page.locator('button:has-text("Accept")').first().click({ timeout: 2000 }).catch(() => {});
  if (!(await clickIfVisible(page, 'adventureButton')))
    await page.locator('a:has-text("Apply"), button:has-text("Apply")').first().click({ timeout: 8000 });
  await sleep(2500);

  // resume upload whenever the drop zone is present
  const resumeName = (profile.candidate.resume_pdf || '').split('/').pop()?.replace(/\.[^.]+$/, '') || 'resume';
  const uploadResume = async () => {
    const fileInput = page.locator('[data-automation-id="file-upload-input-ref"], input[type="file"]').first();
    // skip if the resume filename is already shown (already uploaded)
    if ((await fileInput.count()) && !(await page.getByText(resumeName, { exact: false }).count())) {
      await fileInput.setInputFiles(profile.candidate.resume_pdf).catch(() => {});
      await sleep(4000); // resume parse
    }
  };

  const findNext = async () => {
    for (const id of ['bottom-navigation-next-button', 'pageFooterNextButton', 'continueButton']) {
      const l = aid(page, id);
      if (await vis(l)) return l;
    }
    const b = page.getByRole('button', { name: /^(save and continue|continue|next|review and submit|submit)$/i }).last();
    if ((await b.count()) && (await b.isVisible().catch(() => false))) return b;
    return null;
  };

  // Poll (up to 18s) until the page settles into a recognizable state.
  const waitForState = async () => {
    for (let w = 0; w < 9; w++) {
      await sleep(2000);
      if (await page.locator('text=/application (has been |was )?submitted|thank you for applying|successfully submitted/i').count()) return 'submitted';
      if (await page.locator('input[type="password"]:visible').count()) return 'auth';
      if (await vis(aid(page, 'autofillWithResume'))) return 'start-autofill';
      if (await vis(aid(page, 'applyManually'))) return 'start-manual';
      if (await findNext()) return 'form';
      if (await page.locator('text=/you.{0,10}(already )?applied|application already exists/i').count()) return 'already-applied';
      if (await vis(aid(page, 'adventureButton'))) return 'posting';
    }
    return 'unknown';
  };

  // wizard state machine
  for (let step = 0; step < 14; step++) {
    const state = await waitForState();
    log(`workday[${step}]: state=${state} url=${page.url().slice(0, 90)}`);
    if (state === 'submitted') return { status: 'submitted' };
    if (state === 'already-applied') return { status: 'review', reason: 'workday_already_applied' };
    if (state === 'unknown') break;
    if (state === 'auth') {
      const auth = await authenticate(page, tenant, profile);
      if (!auth.ok) return { status: 'review', reason: auth.reason };
      continue;
    }
    if (state === 'start-autofill') { await clickIfVisible(page, 'autofillWithResume'); continue; }
    if (state === 'start-manual') { await clickIfVisible(page, 'applyManually'); continue; }
    if (state === 'posting') { await clickIfVisible(page, 'adventureButton'); continue; }
    // state === 'form'
    await uploadResume();
    await fillMyInformation(page, profile, pickOption);
    // generic pass covers questionnaire pages, voluntary disclosures, etc.
    const missing = await genericFill(page, job);
    // self-identify disability page: pick "I don't want to answer"
    const dontAnswer = page.locator('label:has-text("t want to answer"), label:has-text("do not want to answer")').last();
    if (await vis(dontAnswer)) await dontAnswer.click().catch(() => {});
    const agree = aid(page, 'agreementCheckbox');
    if (await vis(agree)) await agree.check({ force: true }).catch(() => {});

    const hardMissing = missing.filter((m) => !/self.identif|disability|veteran|gender|ethnic/i.test(m));
    const next = await findNext();
    if (!next) break;
    const nextLabel = ((await next.innerText().catch(() => '')) || (await next.getAttribute('aria-label').catch(() => '')) || '').trim();
    const isSubmit = /submit/i.test(nextLabel);

    if (isSubmit && hardMissing.length)
      return { status: 'review', reason: 'unanswerable_required', missing: hardMissing };
    if (isSubmit && !live) {
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
      return { status: 'dry_run', reason: `reached Submit page; ${hardMissing.length} hard-missing` };
    }
    await wdClick(page, nextLabel || 'Save and Continue', next);
    await sleep(3500);
    const errs = await pageErrors(page);
    if (errs.length) {
      // one retry after generic fill often clears parse-prefill gaps
      await genericFill(page, job);
      await wdClick(page, nextLabel || 'Save and Continue', next).catch(() => {});
      await sleep(3000);
      const errs2 = await pageErrors(page);
      if (errs2.length) return { status: 'review', reason: 'workday_validation', missing: errs2.slice(0, 6) };
    }
    if (await page.locator('text=/application (has been |was )?submitted|thank you for applying|successfully submitted/i').count())
      return { status: 'submitted' };
  }
  if (await page.locator('text=/application (has been |was )?submitted|thank you for applying/i').count())
    return { status: 'submitted' };
  return { status: 'review', reason: 'workday_flow_incomplete' };
}
