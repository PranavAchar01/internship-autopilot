# internship-autopilot

A local-first toolkit that **scouts open internships, screens them against your
profile, and prepares applications** — pulling job data from public ATS feeds
(zero-token), fetching real job descriptions from Greenhouse / Lever / Ashby /
Workday public APIs, scoring fit, generating tailored cover letters, and
producing a ranked, ready-to-submit queue.

It also includes an experimental form-fill engine (Playwright, and an adapter
for BrowserOS / Claude-driven browsing). **Read the honest note on autonomous
submission below before expecting it to auto-apply at scale — it can't, and
neither can anything else.**

## What it does well (the reliable core)

1. **Scout** — pulls active internships from curated public feeds (SimplifyJobs
   and mirrors), filters by category / term / location / title / sponsorship.
   No API keys, no scraping-detection risk.
2. **Qualify** — fetches each real JD from the ATS public API, drops dead
   postings, applies hard eligibility rules (citizenship, clearance,
   sponsorship, grad-year windows), scores skill overlap, and optionally gets a
   strict LLM verdict on minimum qualifications.
3. **Prepare** — generates per-job cover letters and a copy-paste **answer
   sheet** so you can fill any form in seconds.

## The honest note on auto-submission

The form-fill / auto-apply pieces here work end-to-end mechanically (they fill
every field correctly, including react-select dropdowns and file uploads), but
**autonomous submission does not scale** — virtually every ATS walls the final
submit with **reCAPTCHA, SSO, or account login**. A real browser with your
logged-in sessions clears *some* of these (CAPTCHA-free forms submit), but most
do not. This is a wall the entire ATS industry builds on purpose; no tool beats
it without a paid CAPTCHA solver, and even that doesn't handle SSO/account
gating.

**So the recommended use is "prepare, you submit":** let the tool find,
qualify, and prepare applications, then click submit yourself (which sails past
CAPTCHA/SSO because you're human). That gets you to volume, ban-free.

## Setup

```bash
npm install
cp config/profile.example.yml config/profile.yml
# edit config/profile.yml — fill every REQUIRED_TODO (identity, work
# authorization, education, skills, cover paragraphs, candidate_summary)
```

Then:

```bash
node src/scout.mjs      # discover + filter new internships  -> state/queue.json
node src/qualify.mjs    # screen JDs + eligibility + scoring  -> state/qualified.json
node run.mjs            # full pipeline: scout -> qualify -> (apply) -> report
```

Outputs land in `state/` (JSON), `reports/` (daily markdown), and `data/`.

### Optional: LLM screening

Set `llm.enabled: true` and point `llm.binary` at a Claude Code CLI (logged in)
for nuanced qualification verdicts. Without it, screening falls back to rules +
keyword scoring.

### Optional: auto-apply (experimental)

`agentic-apply.mjs` / `applyone.mjs` drive a browser to fill forms. Live
submission is gated behind `apply.live: true` **and** every `REQUIRED_TODO`
filled — a hard interlock so it can't submit with missing legal answers. Expect
most submits to hit the anti-bot wall described above.

## Design principles

- **Answers only from `config/profile.yml`.** An unmapped required field routes
  the application to a review queue — never a guessed answer.
- **Legal/eligibility/demographic answers are never invented.** Work
  authorization, sponsorship, citizenship, and EEO fields come only from your
  config; EEO defaults to "decline to self-identify."
- **Local-first.** Everything runs on your machine against your files. No
  account required for the core discovery/qualification pipeline.

## Structure

```
src/scout.mjs        multi-feed discovery + structural filters
src/qualify.mjs      JD fetch (ATS public APIs) + eligibility + scoring
src/questions.mjs    label -> answer mapping (the "question bank")
src/dropdown.mjs     react-select / native-select fill engine
src/apply.mjs        Playwright form-fill + submit (with guardrails)
src/cover.mjs        per-job cover letter (text + PDF)
src/answersheet.mjs  copy-paste answer sheet for manual submission
src/ats/workday.mjs  Workday multi-page wizard adapter
```

## License

MIT. See [LICENSE](LICENSE). This is a personal-productivity tool; use it in
line with each site's terms of service. It never handles other people's data
and never submits anything you didn't configure.
