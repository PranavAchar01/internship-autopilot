// Agentic apply — the new orchestrator. For each qualified job it invokes a
// headless Claude (`claude -p`) that has the BrowserOS MCP connected, handing
// it the candidate answer sheet + the job, and instructing it to fill and
// submit the application in the user's real BrowserOS browser. Claude's own
// intelligence handles dropdowns / checkboxes / uploads and the anti-bot walls
// are cleared because it is the user's genuine, logged-in browser.
//
// Requirements (one-time, by the user):
//   • `claude` CLI logged in  (run `claude /login`)
//   • BrowserOS running, and its MCP approved once (`claude` interactive → approve)
//   • Gmail signed in inside BrowserOS (for email-verification-code steps)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { loadProfile, loadState, saveState, log, p, sleep, jitter } from './src/lib.mjs';
import { scout } from './src/scout.mjs';
import { qualify } from './src/qualify.mjs';
import { buildAnswerSheet } from './src/answersheet.mjs';
import { coverPdf, closeCoverBrowser } from './src/cover.mjs';

const CLAUDE = process.env.AUTOPILOT_CLAUDE || '/opt/homebrew/bin/claude';
const ROOT = p();

// Keep .mcp.json pointed at BrowserOS's current (dynamic) MCP port.
function refreshMcpPort() {
  try {
    const cfg = JSON.parse(fs.readFileSync(`${process.env.HOME}/Library/Application Support/BrowserOS/.browseros/server_config.json`, 'utf8'));
    const port = cfg.ports.server;
    const mcp = { mcpServers: { browseros: { type: 'http', url: `http://localhost:${port}/mcp` } } };
    fs.writeFileSync(p('.mcp.json'), JSON.stringify(mcp, null, 2));
    return port;
  } catch (e) { log(`agentic: could not refresh BrowserOS port: ${e.message}`); return null; }
}

function applyPrompt(job, answerSheet) {
  return `You are applying to a job on behalf of the candidate, using the BrowserOS browser-automation tools (mcp__browseros__*). This is the candidate's OWN real, logged-in browser.

CANDIDATE ANSWER SHEET (the only source of truth for what to enter):
${answerSheet}

${job._coverPdf ? `Cover letter PDF for THIS job: ${job._coverPdf}` : 'No cover letter file for this job — skip optional cover-letter uploads.'}

JOB TO APPLY TO:
- Company: ${job.company}
- Role: ${job.title}
- Application URL: ${job.applyUrl || job.url}
- Job id: ${job.id}

INSTRUCTIONS:
1. Open the application URL in a NEW BrowserOS tab (tabs action=new), then navigate to it.
2. Take a snapshot. Work through EVERY field in the form. For each: read the label, decide the correct value from the answer sheet, and fill it — text via act fill/type, dropdowns via click→snapshot→click the option, checkboxes/radios via click, file inputs via the upload tool.
3. Handle EVERY required field. For dropdowns, open them, read the real options from the snapshot, and pick the option that matches the answer sheet (e.g. school not listed → "Other"; degree → "Bachelor's"; grad term → matching ${loadProfile().education.expected_grad_year}).
4. Do NOT invent answers for legal / eligibility / demographic / salary questions — use the answer sheet exactly, and decline demographics.
5. After filling, VERIFY with a fresh snapshot that no required field is empty. Fix any that are.
6. If a required field genuinely cannot be answered from the sheet (e.g. a required transcript you don't have, or a graduation window that excludes ${loadProfile().education.expected_grad_year}), do NOT submit — stop and report why.
7. If everything required is filled, click Submit. If an email verification code is required, it was sent to ${loadProfile().candidate.email}: open Gmail in another tab, read the newest code, enter it, and complete submission.
8. Take a final screenshot.

Report your outcome on the LAST line, EXACTLY one of:
RESULT: SUBMITTED
RESULT: NEEDS_REVIEW: <short reason>
RESULT: FAILED: <short reason>`;
}

function runClaude(prompt) {
  return execFileSync(CLAUDE, [
    '-p', prompt,
    '--model', 'sonnet',
    '--mcp-config', p('.mcp.json'),
    '--strict-mcp-config',
    '--allowedTools', 'mcp__browseros__tabs,mcp__browseros__navigate,mcp__browseros__snapshot,mcp__browseros__act,mcp__browseros__read,mcp__browseros__upload,mcp__browseros__screenshot,mcp__browseros__wait,mcp__browseros__grep',
    '--permission-mode', 'acceptEdits',
    '--output-format', 'text',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 600_000, maxBuffer: 20 * 1024 * 1024,
       env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'intern-autopilot-agentic' } });
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const limitArg = args.find((a) => a.startsWith('--limit='));
  log('══ agentic-apply run start ══');

  const port = refreshMcpPort();
  if (!port) { log('agentic: BrowserOS not reachable — is the app running? aborting'); return; }

  try { await scout(); } catch (e) { log(`scout failed: ${e.message}`); }
  try { await qualify(); } catch (e) { log(`qualify failed: ${e.message}`); }

  const profile = loadProfile();
  if (!profile.apply.live && !dry) { log('agentic: apply.live is false — running dry (no submits requested)'); }

  const qualified = loadState('qualified', []);
  const applications = loadState('applications', []);
  const review = loadState('review', []);
  const done = new Set([...applications.map((a) => a.id), ...review.map((r) => r.id)]);
  const cap = Number((limitArg && limitArg.split('=')[1])) || profile.apply.daily_cap || 25;
  const todayStr = new Date().toISOString().slice(0, 10);
  const submittedToday = applications.filter((a) => a.date === todayStr && a.status === 'submitted').length;
  let budget = Math.max(0, cap - submittedToday);

  const targets = qualified.filter((q) => !done.has(q.id)).slice(0, budget);
  log(`agentic: ${targets.length} jobs to attempt (budget ${budget}, port ${port})`);

  const answerSheet = buildAnswerSheet();
  for (const job of targets) {
    if (budget <= 0) break;
    job._coverPdf = await coverPdf(job, profile).catch(() => null);
    if (dry) { log(`agentic: DRY — would apply to ${job.company} — ${job.title}`); continue; }
    let out = '';
    try { out = runClaude(applyPrompt(job, answerSheet)); }
    catch (e) { out = `RESULT: FAILED: ${String(e.message).slice(0, 120)}`; }
    const last = (out.trim().split('\n').filter((l) => l.startsWith('RESULT:')).pop() || out.trim().split('\n').pop() || '').trim();
    const now = new Date().toISOString();
    if (/RESULT:\s*SUBMITTED/i.test(last)) {
      applications.push({ id: job.id, date: todayStr, company: job.company, title: job.title, url: job.applyUrl || job.url, ats: job.ats, status: 'submitted', at: now });
      log(`agentic: SUBMITTED ${job.company} — ${job.title}`);
      budget--;
      saveState('applications', applications);
      await sleep(jitter((profile.apply.min_seconds_between || 90) * 1000));
    } else if (/NEEDS_REVIEW/i.test(last)) {
      review.push({ ...job, reason: last.replace(/.*NEEDS_REVIEW:?/i, '').trim().slice(0, 160) || 'needs review', queuedAt: now });
      saveState('review', review);
      log(`agentic: → review ${job.company} — ${last.slice(0, 100)}`);
    } else {
      review.push({ ...job, reason: `agent: ${last.slice(0, 140)}`, queuedAt: now });
      saveState('review', review);
      log(`agentic: ✗ ${job.company} — ${last.slice(0, 100)}`);
    }
  }
  await closeCoverBrowser();
  log('══ agentic-apply run end ══');
}

await main();
