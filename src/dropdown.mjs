// Shared dropdown engine, built from observed real-form behavior.
//
// Verified mechanics (Greenhouse react-select, Ashby, Workday):
//  • clicking the control focuses an embedded search input; keystrokes typed
//    via page.keyboard.type() filter the option list (this is the ONLY
//    reliable channel — filling the container does nothing).
//  • options render as [role=option] only after the menu opens & filters.
//  • a searchable list may hold hundreds of entries; you MUST filter before
//    matching, and you must NEVER blind-pick options[0] — that once made the
//    filler claim "University of California, Los Angeles" for a candidate at
//    LA Community College. If the real value isn't in the list, use the
//    explicit fallback ("Other") or fail to the review queue. Honesty first.
import { pickOption } from './questions.mjs';
import { p, log, sleep } from './lib.mjs';

const MENU_SEL = '[role="option"]:visible, [data-automation-id="promptOption"]:visible, ul[role="listbox"] li:visible, [role="menuitem"]:visible';
const BRANCH_PREFS = [/^job board/i, /^other/i, /company (web)?site/i, /website|online/i, /career (site|page)/i];
const LEAF_PREFS = [/^other/i, /company (web)?site/i, /simplify/i, /career (site|page)/i, /^online/i];
const NESTED_LABEL = /how did you hear|source|referr/i;

async function readMenu(page, waitMs = 6000) {
  const opts = page.locator(MENU_SEL);
  if (waitMs) await opts.first().waitFor({ state: 'visible', timeout: waitMs }).catch(() => {});
  const n = Math.min(await opts.count(), 60);
  const texts = [];
  for (let i = 0; i < n; i++) texts.push((await opts.nth(i).innerText().catch(() => '')).replace(/\s+/g, ' ').trim());
  return { opts, texts };
}

// pickOption, but when ans.prefer is set, favor an option that contains BOTH
// the value and a preferred token (e.g. year 2029 AND season "spring") — so a
// May grad lands "Spring/Summer 2029", not the first "…2029" which is Winter.
function best(ans, texts) {
  if (ans.prefer) {
    const re = new RegExp(ans.prefer, 'i');
    const both = texts.find((t) => t.toLowerCase().includes(String(ans.value).toLowerCase()) && re.test(t));
    if (both) return both;
  }
  return pickOption(ans, texts);
}

function prefIndex(texts, prefs) {
  for (const re of prefs) {
    const i = texts.findIndex((t) => re.test(t));
    if (i >= 0) return i;
  }
  return -1;
}

async function clearInput(page, loc) {
  await loc.press('ControlOrMeta+a').catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});
  await sleep(200);
}

async function typeAndRead(page, value) {
  await page.keyboard.type(String(value).slice(0, 50), { delay: 25 });
  await sleep(800);
  return readMenu(page, 4000);
}

// Descend a nested category menu (Workday "How did you hear") to a leaf.
async function descend(page, opts, texts, ans) {
  const branch = prefIndex(texts, BRANCH_PREFS);
  await opts.nth(branch >= 0 ? branch : 0).click();
  await sleep(800);
  const sub = await readMenu(page, 4000);
  if (!sub.texts.length) return null;
  const leaf = pickOption(ans, sub.texts) ??
    (prefIndex(sub.texts, LEAF_PREFS) >= 0 ? sub.texts[prefIndex(sub.texts, LEAF_PREFS)] : sub.texts[0]);
  if (leaf) { await sub.opts.nth(sub.texts.indexOf(leaf)).click(); return true; }
  return null;
}

// react-select opens its menu on a mousedown of the .control container, NOT
// the internal (often 2px, opacity:0) search input. Clicking the input alone
// frequently leaves the menu closed in headless. Resolve the real opener.
async function openerFor(loc) {
  const control = loc.locator('xpath=ancestor::*[contains(@class,"control")][1]');
  return (await control.count()) ? control.first() : loc;
}

export async function pickFromDropdown(page, loc, f, ans) {
  const typeable = f.tag === 'input' || f.tag === 'combobox' || ans.kind === 'autocomplete';
  const nested = NESTED_LABEL.test(f.label || '');
  const opener = await openerFor(loc).catch(() => loc);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await opener.click({ timeout: 5000 });
      await sleep(500);
      let { opts, texts } = await readMenu(page);
      // menu didn't open on the control — fall back to clicking the input
      if (!texts.length && opener !== loc) { await loc.click({ timeout: 3000 }).catch(() => {}); await sleep(400); ({ opts, texts } = await readMenu(page)); }

      // Plain text input masquerading as a dropdown (no menu opened)
      if (!texts.length) {
        if (typeable && !nested && typeof ans.value === 'string' && ans.kind !== 'decline') {
          await page.keyboard.type(String(ans.value).slice(0, 60), { delay: 20 });
          ({ opts, texts } = await readMenu(page, 2500));
          if (!texts.length) return true; // it was a free input; post-check verifies
        } else { continue; }
      }

      // 1. Nested category prompt (Workday source) — descend, never type
      if (nested && texts.length) {
        const branchMatch = pickOption(ans, texts);
        if (branchMatch) { await opts.nth(texts.indexOf(branchMatch)).click(); await sleep(600); }
        else if (await descend(page, opts, texts, ans)) { /* done */ }
        else { await page.keyboard.press('Escape'); continue; }
        if (await page.locator(MENU_SEL).count()) await page.keyboard.press('Escape');
        return true;
      }

      // 2. Direct match on the open (unfiltered) list — short lists only, so
      //    we don't false-match against a truncated 60-of-800 school list
      let choice = texts.length < 25 ? best(ans, texts) : null;

      // 3. Type to filter, then match
      if (!choice && typeable && typeof ans.value === 'string') {
        await clearInput(page, loc);
        ({ opts, texts } = await typeAndRead(page, ans.value));
        choice = best(ans, texts);

        // 3b. real value absent → explicit fallback ("Other"); never guess
        if (!choice && ans.fallback) {
          await clearInput(page, loc);
          ({ opts, texts } = await typeAndRead(page, ans.fallback));
          choice = pickOption({ kind: 'option', value: ans.fallback }, texts) ||
            (texts.length === 1 ? texts[0] : null);
        }
      }

      // 4. Still nothing but a short list → try descending (some non-labeled nested menus)
      if (!choice && texts.length && texts.length < 12 && !typeable) {
        if (await descend(page, opts, texts, ans)) {
          if (await page.locator(MENU_SEL).count()) await page.keyboard.press('Escape');
          return true;
        }
      }

      if (!choice) { await page.keyboard.press('Escape'); continue; }
      await opts.nth(texts.indexOf(choice)).click();
      await sleep(500);
      if (await page.locator(MENU_SEL).count()) await page.keyboard.press('Escape');
      return true;
    } catch { /* retry */ }
  }

  const shot = p('logs', `dropdown-fail-${Date.now()}.png`);
  await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
  log(`dropdown: could not answer "${String(f.label).slice(0, 70)}" — screenshot ${shot.split('/').pop()}`);
  return false;
}
