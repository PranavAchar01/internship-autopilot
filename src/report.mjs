// Daily report: what was found, what was applied to, what needs you.
import fs from 'node:fs';
import { loadState, loadProfile, todosRemaining, p, log } from './lib.mjs';

export function report() {
  const profile = loadProfile();
  const todos = todosRemaining(profile);
  const apps = loadState('applications', []);
  const review = loadState('review', []);
  const qualified = loadState('qualified', []);
  const rejected = loadState('rejected', []);
  const queue = loadState('queue', []);
  const today = new Date().toISOString().slice(0, 10);
  const todayApps = apps.filter((a) => a.date === today);
  const appliedIds = new Set(apps.map((a) => a.id));
  const reviewIds = new Set(review.map((r) => r.id));
  const remaining = qualified.filter((q) => !appliedIds.has(q.id) && !reviewIds.has(q.id));

  const lines = [
    `# Intern Autopilot — ${today}`, '',
    `**Mode:** ${profile.apply.live && !todos.length ? '🟢 LIVE' : `🟡 DRY-RUN${todos.length ? ` (blocked by ${todos.length} unfilled profile fields)` : ''}`}`, '',
    `| | count |`, `|---|---|`,
    `| Submitted today | ${todayApps.filter((a) => a.status.startsWith('submitted')).length} |`,
    `| Submitted all-time | ${apps.filter((a) => a.status.startsWith('submitted')).length} |`,
    `| Dry-run passes today | ${todayApps.filter((a) => a.status === 'dry_run').length} |`,
    `| Qualified, waiting to apply | ${remaining.length} |`,
    `| Needs your review | ${review.length} |`,
    `| Awaiting screening | ${queue.length} |`,
    `| Rejected (unqualified/ineligible) | ${rejected.length} |`, '',
  ];
  if (todos.length) lines.push(`## ⚠️ Fill these in config/profile.yml to go live`, '', ...todos.map((t) => `- \`${t}\``), '');
  if (todayApps.length) {
    lines.push(`## Today's applications`, '');
    for (const a of todayApps) lines.push(`- **${a.company}** — ${a.title} · ${a.status} · [posting](${a.url})`);
    lines.push('');
  }
  if (review.length) {
    lines.push(`## Review queue (apply manually or fix profile)`, '');
    for (const r of review.slice(-40)) lines.push(`- **${r.company}** — ${r.title} · _${r.reason}_${r.missing?.length ? ` · missing: ${r.missing.slice(0, 3).join('; ')}` : ''} · [apply](${r.url})`);
    lines.push('');
  }
  const file = p('reports', `${today}.md`);
  fs.writeFileSync(file, lines.join('\n'));

  // applications.csv (full history, spreadsheet-friendly)
  const csv = ['date,company,title,status,ats,url',
    ...apps.map((a) => [a.date, a.company, a.title, a.status, a.ats, a.url].map((x) => `"${String(x ?? '').replace(/"/g, '""')}"`).join(','))];
  fs.writeFileSync(p('data', 'applications.csv'), csv.join('\n'));
  log(`report: wrote ${file}`);
  return file;
}

if (import.meta.url === `file://${process.argv[1]}`) report();
