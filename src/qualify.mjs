// Stage 2 — QUALIFY: for each queued listing, fetch the real JD from the
// ATS public API, verify liveness, run hard eligibility rules, score skill
// overlap, and (optionally) get a headless-Claude verdict. Qualified
// listings move to state/qualified.json; everything else is recorded with
// its reason so nothing is silently dropped.
import { execFileSync } from 'node:child_process';
import { loadProfile, loadState, saveState, fetchJd, log, sleep, jitter } from './lib.mjs';

const RULES = [
  { key: 'citizenship', re: /\b(u\.?s\.? citizen(ship)? (is )?required|must be a u\.?s\.? citizen|citizenship: ?required|itar)\b/i,
    fails: (p) => p.eligibility.us_citizen !== true },
  { key: 'clearance', re: /\b(security clearance|ts\/sci|top secret|secret clearance)\b/i,
    fails: () => true },
  { key: 'no_sponsorship', re: /\b(unable to (provide|offer) (visa )?sponsorship|not (provide|offer) sponsorship|without (the need for )?sponsorship|sponsorship is not available)\b/i,
    fails: (p) => p.eligibility.require_sponsorship === true },
  { key: 'grad_only', re: /\b(pursuing (a |an )?(master'?s|ms|m\.s\.|phd|ph\.d\.|doctora)|master'?s or phd|graduate students? only|enrolled in (a )?(master|phd))\b/i,
    fails: (p) => /bachelor/i.test(p.education.degree_level) },
];

function hardRules(jdText, profile) {
  const reasons = [];
  for (const r of RULES) if (r.re.test(jdText) && r.fails(profile)) reasons.push(r.key);
  // Grad-year window: "graduating between X and Y" / "graduate in 20XX"
  const gy = Number(profile.education.expected_grad_year);
  if (gy) {
    const m = jdText.match(/graduat\w+ (?:date )?(?:between |by |in |on or before )?(?:\w+ )?(20\d\d)(?:\s*(?:and|to|-|–)\s*(?:\w+ )?(20\d\d))?/i);
    if (m) {
      const lo = Number(m[1]), hi = Number(m[2] || m[1]) + (m[2] ? 0 : 1); // single year → allow ±1
      if (gy < lo - 1 || gy > hi + 1) reasons.push(`grad_window_${lo}-${hi}`);
    }
  }
  return reasons;
}

function keywordScore(jdText, skills) {
  const t = jdText.toLowerCase();
  return skills.filter(s => t.includes(s.toLowerCase())).length;
}

function llmVerdicts(batch, profile) {
  // One headless-Claude call for the whole batch; strict JSON out.
  const items = batch.map(b => ({ id: b.id, company: b.company, title: b.title, jd: b.jdText.slice(0, 3500) }));
  const summary = profile.candidate_summary || `A student candidate. Skills: ${(profile.skills || []).join(', ')}.`;
  const prompt = `You are screening internship postings for this candidate. Candidate: ${summary}

For EACH posting below, answer: does the candidate plausibly meet the posting's stated MINIMUM qualifications (class standing, degree program, specific required coursework/skills)? Be strict about hard requirements (e.g. "must be enrolled in a 4-year university", "juniors/seniors only", specific majors excluded, PhD-track research) and lenient about preferred/nice-to-have items. Respond with ONLY a JSON array: [{"id": "...", "qualified": true|false, "fit": 1-5, "reason": "<15 words"}].

POSTINGS:\n${JSON.stringify(items)}`;
  try {
    const out = execFileSync(profile.llm.binary, ['-p', '--output-format', 'text', '--model', 'sonnet'], {
      input: prompt, encoding: 'utf8', timeout: 300_000, maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'intern-autopilot' },
    });
    const m = out.match(/\[[\s\S]*\]/);
    if (!m) throw new Error('no JSON in LLM output');
    return Object.fromEntries(JSON.parse(m[0]).map(v => [v.id, v]));
  } catch (e) {
    log(`qualify: LLM verdict unavailable (${e.message.slice(0, 120)}) — falling back to rules-only`);
    return null;
  }
}

export async function qualify() {
  const profile = loadProfile();
  const queue = loadState('queue', []);
  const qualified = loadState('qualified', []);
  const rejected = loadState('rejected', []);
  const seen = loadState('seen', {});
  if (!queue.length) { log('qualify: queue empty'); return { checked: 0 }; }

  const batchLimit = profile.llm?.max_jd_per_run ?? 60;
  const toCheck = queue.splice(0, batchLimit);
  const pending = [];

  for (const item of toCheck) {
    const jd = await fetchJd(item);
    await sleep(jitter(400));
    if (jd.live === false) { seen[item.id] = 'dead'; continue; }
    if (!jd.text) {
      // No public API for this ATS — keep it, flag for manual/browser handling
      pending.push({ ...item, ats: jd.ats, jdText: '', applyUrl: item.url, jdUnavailable: true, keywordScore: null, hardFails: [] });
      continue;
    }
    const hardFails = hardRules(jd.text, profile);
    const score = keywordScore(jd.text, profile.skills);
    if (hardFails.length) { rejected.push({ id: item.id, company: item.company, title: item.title, url: item.url, reasons: hardFails }); seen[item.id] = 'rejected'; continue; }
    if (score < profile.preferences.min_keyword_score) { rejected.push({ id: item.id, company: item.company, title: item.title, url: item.url, reasons: [`keyword_score_${score}`] }); seen[item.id] = 'rejected'; continue; }
    pending.push({ ...item, ats: jd.ats, board: jd.board, jobId: jd.jobId, applyUrl: jd.applyUrl || item.url, jdText: jd.text, keywordScore: score, hardFails: [] });
  }

  // LLM pass over the survivors with JD text
  let verdicts = null;
  if (profile.llm?.enabled && pending.some(x => x.jdText)) {
    verdicts = llmVerdicts(pending.filter(x => x.jdText), profile);
  }
  for (const item of pending) {
    const v = verdicts?.[item.id];
    if (v && !v.qualified) {
      rejected.push({ id: item.id, company: item.company, title: item.title, url: item.url, reasons: [`llm: ${v.reason}`] });
      seen[item.id] = 'rejected';
      continue;
    }
    item.fit = v?.fit ?? null;
    item.llmReason = v?.reason ?? null;
    delete item.jdText; // keep state small; apply stage re-fetches if needed
    qualified.push(item);
    seen[item.id] = 'qualified';
  }

  qualified.sort((a, b) => (b.fit ?? 3) - (a.fit ?? 3) || (b.keywordScore ?? 0) - (a.keywordScore ?? 0));
  saveState('queue', queue);
  saveState('qualified', qualified);
  saveState('rejected', rejected);
  saveState('seen', seen);
  log(`qualify: checked=${toCheck.length} qualified+=${pending.filter(x => !verdicts?.[x.id] || verdicts[x.id].qualified).length} (total qualified=${qualified.length}, rejected=${rejected.length}, queue left=${queue.length})`);
  return { checked: toCheck.length };
}

if (import.meta.url === `file://${process.argv[1]}`) await qualify();
