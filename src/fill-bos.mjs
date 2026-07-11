// BrowserOS filler — fills a job application in the user's real browser.
// Strategy: read the field list with an injected DOM scan (evaluate), map each
// field to an answer with the existing answer-bank (answerFor + overrides),
// then fill: simple fields + native selects + checkboxes via one injected
// routine; react-select dropdowns and file inputs via BrowserOS `act`/`upload`
// (real human events) so they behave exactly as if the user did it.
import * as bos from './bos.mjs';
import { answerFor, pickOption } from './questions.mjs';
import { loadState } from './lib.mjs';

// ── the in-page scanner (returned to Node as JSON) ──────────────────────────
const SCAN_JS = `
const norm = (s) => (s||'').replace(/\\s+/g,' ').trim();
const labelFor = (el) => {
  let t='';
  if (el.id) t=document.querySelector('label[for="'+CSS.escape(el.id)+'"]')?.textContent||'';
  if (!t) t=el.getAttribute('aria-label')||'';
  if (!t) t=el.closest('label')?.textContent||'';
  if (!t) t=el.closest('.application-question')?.querySelector('.application-label')?.textContent||'';
  if (!t) t=el.closest('div,fieldset,li')?.querySelector('label,legend,[class*="label"]')?.textContent||'';
  if (!t) t=el.placeholder||el.name||'';
  return norm(t).slice(0,200);
};
const isReq = (el,l,le) => {
  if (el.required || el.getAttribute('aria-required')==='true' || /[*✱]|\\brequired\\b/i.test(l)) return true;
  le = le || (el.id && document.querySelector('label[for="'+CSS.escape(el.id)+'"]')) || el.closest('div,fieldset')?.querySelector('label,legend');
  return !!le && (/(^|[_\\s-])required/i.test(le.className) || (getComputedStyle(le,'::after').content||'').includes('*'));
};
const out=[]; const seen=new Set(); let idx=0;
const tag=(el)=>{ el.setAttribute('data-bosid','b'+(idx++)); return el.getAttribute('data-bosid'); };
for (const el of document.querySelectorAll('input,textarea,select')) {
  if (['hidden','submit','button'].includes(el.type)) continue;
  if (String(el.className).includes('requiredInput')) continue;
  if (el.disabled) continue;
  if (el.offsetParent===null && !['file','radio','checkbox'].includes(el.type)) continue;
  if ((el.type==='checkbox'||el.type==='radio') && el.closest('[class*="yesno"]')) continue;
  if (el.type==='radio'||el.type==='checkbox') {
    if (seen.has('g|'+el.name)) continue; seen.add('g|'+el.name);
    const group=[...document.querySelectorAll('input[name="'+CSS.escape(el.name)+'"]')];
    const qid=el.name.includes('_')?el.name.split('_').pop():null;
    const le=(qid&&document.querySelector('label[for="'+CSS.escape(qid)+'"]'))||el.closest('.application-question')?.querySelector('.application-label')||el.closest('fieldset,[role="group"],div')?.querySelector('legend,label,[class*="label"]');
    const lbl=norm(le?.textContent||labelFor(el)).slice(0,200);
    out.push({ kind:'group', gtype:el.type, name:el.name, label:lbl, required:isReq(el,lbl,le),
      options: group.map(g=>({ text: norm(g.labels?.[0]?.textContent||g.closest('label')?.textContent||g.value), id: tag(g) })),
      filled: group.some(g=>g.checked) });
    continue;
  }
  const rs = el.getAttribute('role')==='combobox' || el.getAttribute('aria-autocomplete')==='list';
  const l = labelFor(el);
  const id = tag(el);
  if (el.tagName==='SELECT') {
    out.push({ kind:'select', id, label:l, required:isReq(el,l),
      options:[...el.options].map(o=>norm(o.textContent)).filter(Boolean),
      filled: el.selectedIndex>0 && !!norm(el.options[el.selectedIndex]?.value) });
  } else if (rs) {
    const ctrl=el.closest('[class*="control"],[class*="ValueContainer"]')||el.parentElement;
    const chosen=norm(ctrl?.querySelector('[class*="singleValue"],[class*="multiValue"]')?.textContent||'');
    out.push({ kind:'reactselect', id, label:l, required:isReq(el,l), filled: !!chosen, chosen });
  } else if (el.type==='file') {
    out.push({ kind:'file', id, label:l, accept:el.accept||'', required:isReq(el,l),
      filled: el.files.length>0 || !!el.closest('div')?.textContent?.includes('.pdf') });
  } else {
    out.push({ kind:'text', id, itype:el.type, label:l, required:isReq(el,l), filled: !!norm(el.value) });
  }
}
// Ashby yes/no button pairs
for (const el of document.querySelectorAll('[class*="yesno"]')) {
  const btns=[...el.querySelectorAll('button')]; if (btns.length<2) continue;
  const name=el.querySelector('input')?.name||''; if (!name||seen.has('yn|'+name)) continue; seen.add('yn|'+name);
  const le=document.querySelector('label[for="'+CSS.escape(name)+'"]');
  const lbl=norm(le?.textContent||labelFor(el)).slice(0,200);
  el.setAttribute('data-bosyn',name);
  out.push({ kind:'yesno', name, label:lbl, required:isReq(el,lbl,le),
    options: btns.map(b=>({text:norm(b.textContent)})), filled: btns.some(b=>/active|selected/i.test(b.className)) });
}
return JSON.stringify(out);
`;

async function scan(page) {
  const r = await bos.evaluate(page, SCAN_JS);
  return typeof r === 'string' ? JSON.parse(r) : r;
}

// fill a plain text/email/textarea by bosid. Uses the NATIVE value setter so
// React controlled inputs accept the value instead of reverting it on re-render.
async function setText(page, id, value) {
  return bos.evaluate(page, `
    const el=document.querySelector('[data-bosid="${id}"]');
    if(!el) return 'nf';
    el.focus();
    const proto=el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;
    const setter=Object.getOwnPropertyDescriptor(proto,'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input',{bubbles:true}));
    el.dispatchEvent(new Event('change',{bubbles:true}));
    el.blur();
    return el.value===${JSON.stringify(value)}?'ok':'reverted';`);
}
async function setNativeSelect(page, id, label) {
  return bos.evaluate(page, `
    const el=document.querySelector('[data-bosid="${id}"]');
    if(!el) return 'nf';
    const want=${JSON.stringify(label)}.toLowerCase();
    const opt=[...el.options].find(o=>o.textContent.trim().toLowerCase()===want) || [...el.options].find(o=>o.textContent.trim().toLowerCase().includes(want));
    if(!opt) return 'noopt';
    el.value=opt.value; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));
    return 'ok';`);
}
// Parse BrowserOS's accessibility-tree snapshot into {role,text,ref,flags}.
// Lines look like:  - combobox "Label" [required] [collapsed] [ref=e22]
function parseSnapshot(snap) {
  const out = [];
  for (const line of String(snap).split('\n')) {
    const m = line.match(/^\s*-?\s*(\w+)\s+"([^"]*)"(.*?)\[ref=(e\d+)\]/);
    if (m) out.push({ role: m[1], text: m[2].replace(/\s+/g, ' ').trim(), flags: m[3], ref: m[4] });
    else {
      const m2 = line.match(/^\s*-?\s*(\w+)(.*?)\[ref=(e\d+)\]/);
      if (m2) out.push({ role: m2[1], text: '', flags: m2[2], ref: m2[3] });
    }
  }
  return out;
}
const norm = (s) => String(s).toLowerCase().replace(/[*✱]/g, '').replace(/\s+/g, ' ').trim();
function findRef(entries, label, roles) {
  const L = norm(label).slice(0, 50);
  const cand = entries.filter((e) => roles.includes(e.role) && e.text);
  return (cand.find((e) => norm(e.text) === L) ||
    cand.find((e) => norm(e.text).includes(L) || L.includes(norm(e.text)))) || null;
}

// react-select via native refs: click (auto-scrolls), type to filter, snapshot
// options, click the matching option ref. Reliable, coordinate-free.
async function readOptions(page, tries = 4) {
  for (let i = 0; i < tries; i++) {
    const opts = parseSnapshot(await bos.snapshot(page)).filter((e) => e.role === 'option' && e.text);
    if (opts.length) return opts;
    await bos.sleep(500);
  }
  return [];
}
// bosId is the react-select's inner <input> (tagged during scan). Clicking the
// combobox wrapper ref lands focus on BODY, so we focus the input directly via
// its data-bosid — that opens the menu — then type to filter and click the
// matching option by its fresh snapshot ref.
// Locate the react-select CONTROL from its label (input & label live in
// separate subtrees), scroll into view, return viewport-center coords. A real
// coordinate click on the control opens the menu — ref/input clicks don't.
async function controlCoords(page, label) {
  const L = JSON.stringify(norm(label).slice(0, 45));
  return bos.evaluate(page, `
    const want=${L};
    const norm=(s)=>(s||'').toLowerCase().replace(/[*✱]/g,'').replace(/\\s+/g,' ').trim();
    const labs=[...document.querySelectorAll('.application-label,label,legend')];
    const lab=labs.find(l=>{const t=norm(l.textContent); return t && (t.includes(want)||want.includes(t));});
    if(!lab) return {err:'nolabel'};
    let q=lab.closest('.application-question')||lab.parentElement;
    let c=q&&q.querySelector('[class*="control"]');
    if(!c){ q=lab.parentElement&&lab.parentElement.parentElement; c=q&&q.querySelector('[class*="control"]'); }
    if(!c) return {err:'nocontrol'};
    c.scrollIntoView({block:'center'});
    const r=c.getBoundingClientRect();
    return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)};`);
}

async function fillReactSelect(page, label, ans) {
  for (const val of [ans.value, ans.fallback].filter(Boolean)) {
    const co = await controlCoords(page, label);
    if (!co || co.x == null) return false;
    await bos.act(page, { kind: 'click_at', x: co.x, y: co.y }).catch(() => {});
    await bos.sleep(800);
    let opts = await readOptions(page, 3);
    if (!opts.length || opts.length > 12 || !pickOption({ kind: 'option', value: val }, opts.map((o) => o.text))) {
      await bos.act(page, { kind: 'type', text: String(val).slice(0, 40) }).catch(() => {});
      await bos.sleep(800);
      const o2 = await readOptions(page, 3);
      if (o2.length) opts = o2;
    }
    if (!opts.length) { await bos.act(page, { kind: 'press', key: 'Escape' }).catch(() => {}); continue; }
    const texts = opts.map((o) => o.text);
    let choice = null;
    if (ans.prefer) { const re = new RegExp(ans.prefer, 'i'); choice = texts.find((t) => norm(t).includes(norm(val)) && re.test(t)); }
    choice = choice || pickOption({ kind: 'option', value: val }, texts);
    if (!choice) { await bos.act(page, { kind: 'press', key: 'Escape' }).catch(() => {}); continue; }
    await bos.act(page, { kind: 'click', ref: opts.find((o) => o.text === choice).ref }).catch(() => {});
    await bos.sleep(450);
    return true;
  }
  return false;
}

function overrideFor(job, label) {
  const all = loadState('answer-overrides', {});
  const forJob = all[job.id]; if (!forJob) return null;
  const norm = (s) => s.toLowerCase().replace(/[*✱]/g, '').replace(/\s+/g, ' ').trim();
  return forJob[label] || forJob[Object.keys(forJob).find((k) => norm(k) === norm(label))] || null;
}

// Fill the whole form. Returns { filled, missing }.
export async function fillForm(page, job, profile) {
  const fields = await scan(page);
  let entries = parseSnapshot(await bos.snapshot(page));
  const missing = []; let filled = 0;

  for (const f of fields) {
    // files: map by id/accept (never the "Attach" button label); upload via ref
    if (f.kind === 'file') {
      const key = `${f.label} ${f.accept}`.toLowerCase();
      let path = profile.candidate.resume_pdf;
      if (/cover/.test(key)) path = job._coverPdf || null;
      else if (/transcript/.test(key)) path = profile.candidate.transcript_pdf || null;
      if (!path) { if (f.required && !f.filled) missing.push(f.label || 'file'); continue; }
      if (f.filled) { filled++; continue; }
      const ok = await uploadFile(page, f, path);
      if (ok) filled++; else if (f.required) missing.push(f.label || 'file upload');
      await bos.sleep(700);
      continue;
    }
    const label = f.label;
    const ans = overrideFor(job, label) || answerFor(label, profile, job);
    if (!ans || ans.kind === 'skip') { if (f.required && !f.filled) missing.push(label || `(${f.kind})`); continue; }
    if (f.filled) { filled++; continue; }

    try {
      if (f.kind === 'text') {
        const r = await setText(page, f.id, String(ans.value));
        if (r === 'ok') filled++; else if (f.required) missing.push(label);
      } else if (f.kind === 'select') {
        let v = ans.value;
        if (ans.kind === 'date') v = /year/i.test(label) ? ans.year : /month/i.test(label) ? ans.month : ans.value;
        const choice = pickOption(ans.kind === 'bool' ? ans : { kind: 'option', value: v, fallback: ans.fallback }, f.options) || v;
        const r = await setNativeSelect(page, f.id, choice);
        if (r === 'ok') filled++; else if (f.required) missing.push(label);
      } else if (f.kind === 'reactselect') {
        let a = ans;
        if (ans.kind === 'date') {
          const season = /jan|feb|mar|apr|may/i.test(ans.month) ? 'spring|summer' : /jun|jul|aug/i.test(ans.month) ? 'summer|fall' : 'fall|winter';
          a = { kind: 'option', value: /month/i.test(label) ? ans.month : ans.year, fallback: ans.year, prefer: /month|year/i.test(label) ? null : season };
        }
        const ok = await fillReactSelect(page, label, a);
        if (ok) filled++; else if (f.required) missing.push(label);
      } else if (f.kind === 'group') {
        const choice = pickOption(ans.kind === 'consent' ? { kind: 'bool', value: 'Yes' } : ans, f.options.map((o) => o.text));
        const targetText = choice || (ans.kind === 'consent' ? f.options[0]?.text : null);
        if (!targetText) { if (f.required) missing.push(label); continue; }
        entries = parseSnapshot(await bos.snapshot(page));
        const ref = findRef(entries, targetText, ['checkbox', 'radio']) || findRef(entries, label, ['checkbox', 'radio']);
        if (ref) { await bos.act(page, { kind: 'click', ref: ref.ref }); filled++; }
        else if (f.required) missing.push(label);
      } else if (f.kind === 'yesno') {
        const choice = pickOption(ans.kind === 'consent' ? { kind: 'bool', value: 'Yes' } : ans, f.options.map((o) => o.text));
        if (!choice) { if (f.required) missing.push(label); continue; }
        entries = parseSnapshot(await bos.snapshot(page));
        const ref = findRef(entries, choice, ['button']);
        if (ref) { await bos.act(page, { kind: 'click', ref: ref.ref }); filled++; }
        else if (f.required) missing.push(label);
      }
    } catch (e) { if (f.required) missing.push(label); }
    await bos.sleep(250);
  }

  // post-fill verification: re-scan, flag required+still-empty
  await bos.sleep(1000);
  const after = await scan(page);
  for (const f of after) if (f.required && !f.filled) {
    const lbl = f.label || `(${f.kind})`;
    if (!missing.includes(lbl)) missing.push(lbl);
  }
  return { filled, missing };
}

// Upload a file. Prefer a snapshot ref for the file input; fall back to a
// button ("Attach") ref that reveals it.
async function uploadFile(page, f, path) {
  const entries = parseSnapshot(await bos.snapshot(page));
  // BrowserOS often surfaces the input as a button labeled Attach/Upload
  let ref = entries.find((e) => e.role === 'button' && /attach|upload|resume|cv|cover|file/i.test(e.text));
  // or a dedicated file control
  if (!ref) ref = entries.find((e) => /file|upload/i.test(e.role));
  if (!ref) {
    // last resort: tag the file input and try uploading by CSS via evaluate path
    try { await bos.upload(page, `[data-bosid="${f.id}"]`, path); return true; } catch { return false; }
  }
  try { await bos.upload(page, ref.ref, path); return true; }
  catch { try { await bos.upload(page, `[data-bosid="${f.id}"]`, path); return true; } catch { return false; } }
}
