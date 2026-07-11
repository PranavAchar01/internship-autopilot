// Emit a human-readable "answer sheet" from profile.yml + answer-overrides,
// so the driving agent knows exactly what to enter — and, crucially, what NOT
// to guess. This is the single source of truth handed to the BrowserOS agent.
import { loadProfile, loadState, p } from './lib.mjs';
import fs from 'node:fs';

export function buildAnswerSheet() {
  const pr = loadProfile();
  const c = pr.candidate, e = pr.eligibility, ed = pr.education, a = pr.answers, pf = pr.preferences;
  const age18 = e.date_of_birth ? (new Date(new Date(e.date_of_birth).getFullYear() + 18, new Date(e.date_of_birth).getMonth(), new Date(e.date_of_birth).getDate()) <= new Date()) : null;

  const lines = [
    `# Candidate answer sheet — ${c.full_name}`,
    ``,
    `Fill every application AS THIS PERSON. Use ONLY the values below. If a REQUIRED field has no matching answer here and cannot be reasonably derived, STOP that application and report it as "needs review: <question>" — never invent legal, eligibility, demographic, or salary answers.`,
    ``,
    `## Identity & contact`,
    `- First name: ${c.first_name}`,
    `- Last name: ${c.last_name}`,
    `- Email: ${c.email}`,
    `- Phone: ${c.phone} (mobile; country code +1 / United States)`,
    `- Address: ${c.street_address}, ${c.city}, ${c.state} ${c.zip}, United States`,
    `- LinkedIn: ${c.linkedin}`,
    `- GitHub: ${c.github}`,
    `- Website/portfolio: ${c.website}`,
    `- Current company (if asked): ${c.current_company || '(leave blank / N/A for students)'}`,
    ``,
    `## Files to upload`,
    `- Resume/CV: ${c.resume_pdf}`,
    `- Cover letter: use the per-job PDF path given with each job (if provided)`,
    `- Transcript: ${c.transcript_pdf || '(none on file — if a transcript upload is REQUIRED, mark needs-review)'}`,
    ``,
    `## Education`,
    `- School: ${ed.school}. If a dropdown of schools does not list it, choose "Other".`,
    `- Degree: Bachelor's (choose "Bachelor's" / "Bachelor's Degree" / "Undergrad" as offered)`,
    `- Major / discipline / field of study: ${ed.major}`,
    `- GPA: ${ed.gpa}`,
    `- Expected graduation: ${ed.expected_grad_month} ${ed.expected_grad_year} (for term dropdowns choose Spring or Spring/Summer ${ed.expected_grad_year}; match the YEAR ${ed.expected_grad_year} first). If the latest option is earlier than ${ed.expected_grad_year}, mark needs-review (you don't qualify for their window).`,
    `- Currently enrolled: Yes`,
    ``,
    `## Work eligibility (legal — answer EXACTLY these)`,
    `- Authorized to work in the US: ${e.authorized_to_work_us ? 'Yes' : 'No'}. On multi-option questions choose the "Citizen or Permanent Resident / Green Card" option, NOT a visa option.`,
    `- Require sponsorship (now or future): ${e.require_sponsorship ? 'Yes' : 'No'}`,
    `- US citizen: ${e.us_citizen ? 'Yes' : 'No'}`,
    `- Export-control "US person" / ITAR eligible: ${e.us_citizen ? 'Yes' : 'mark needs-review'}`,
    `- At least 18 years old: ${age18 === null ? 'mark needs-review' : age18 ? 'Yes' : 'No (turns 18 on ' + e.date_of_birth + ')'}`,
    `- Date of birth (only if explicitly required): ${e.date_of_birth ? e.date_of_birth.split('-').reverse().join('/').replace(/(\d+)\/(\d+)\/(\d+)/, '$2/$1/$3') : 'mark needs-review'}`,
    `- Security clearance: None`,
    `- Felony/criminal disclosure: No`,
    ``,
    `## Logistics & standard questions`,
    `- How did you hear: "${a.how_did_you_hear}" (or "Other" → "Simplify job board")`,
    `- Willing to relocate: Yes`,
    `- Available full-time (40hr/wk) during a term: ${a.available_full_time_internship || 'Yes'}`,
    `- Earliest start date: ${pf.earliest_start}`,
    `- Salary expectation: ${a.salary_expectation}`,
    `- Prior government employment: ${a.prior_government_employment || 'No'}`,
    `- Notice period: Available immediately`,
    `- Previously worked here / contingent worker: No`,
    `- Referred by an employee: No`,
    `- SWE interest area (if asked): ${a.swe_interest_area || 'Full-stack Development'}`,
    ``,
    `## EEO / demographic self-identification`,
    `- Decline to self-identify on ALL of: gender, race/ethnicity, hispanic/latino, veteran status, disability status. Choose "Decline to self-identify" / "I don't wish to answer" / "I do not want to answer".`,
    ``,
    `## Consent / agreement checkboxes`,
    `- Check/acknowledge privacy-policy, notice-at-collection, and "information is true" certification boxes. For marketing/SMS opt-in, choose No/decline.`,
    ``,
    `## Free-text "why this company / tell us about yourself"`,
    `Use this (tighten to fit limits): ${a.why_company_fallback.replace(/\s+/g, ' ').trim()}`,
    ``,
    `## About the candidate (for tailoring free-text only — never contradict the facts above)`,
    pr.candidate_summary || `(Set candidate_summary in config/profile.yml — a 3-4 sentence bio the agent uses to tailor free-text answers.)`,
  ];

  const overrides = loadState('answer-overrides', {});
  if (Object.keys(overrides).length) {
    lines.push('', '## Per-job specific answers (match by job id)');
    lines.push('These override the generic answers for the matching job id:', '```json', JSON.stringify(overrides).slice(0, 4000), '```');
  }
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = buildAnswerSheet();
  fs.writeFileSync(p('data', 'answer-sheet.md'), out);
  console.log(out);
}
