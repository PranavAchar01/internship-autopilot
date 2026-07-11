// Stage 1 — SCOUT: pull the SimplifyJobs internship feed, apply cheap
// structural filters (active, category, term, location, sponsorship,
// title), and queue anything new for qualification.
import { loadProfile, loadState, saveState, fetchJson, log } from './lib.mjs';

// Multiple curated feeds; each is best-effort (a 404/renamed repo just logs).
// Cross-feed duplicates are dropped by URL, then by company|title|term.
const FEEDS = [
  'https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/.github/scripts/listings.json',
  'https://raw.githubusercontent.com/vanshb03/Summer2026-Internships/dev/.github/scripts/listings.json',
  'https://raw.githubusercontent.com/cvrve/Summer2026-Internships/dev/.github/scripts/listings.json',
];

export async function scout() {
  const profile = loadProfile();
  const prefs = profile.preferences;
  const seen = loadState('seen', {});
  const queue = loadState('queue', []);
  const queued = new Set(queue.map(q => q.id));

  const listings = [];
  const dupe = new Set();
  for (const feed of FEEDS) {
    try {
      const items = await fetchJson(feed);
      let added = 0;
      for (const l of items) {
        const key = (l.url || '').replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase() ||
          `${l.company_name}|${l.title}|${(l.terms || []).join(',')}`.toLowerCase();
        if (dupe.has(key)) continue;
        dupe.add(key);
        listings.push(l);
        added++;
      }
      log(`scout: ${feed.split('/')[3]} feed → ${items.length} items, ${added} unique`);
    } catch (e) {
      log(`scout: feed unavailable (${feed.split('/')[3]}): ${e.message.slice(0, 80)}`);
    }
  }

  const stats = { active: 0, category: 0, term: 0, title: 0, location: 0, sponsorship: 0, new: 0 };
  for (const l of listings) {
    if (!l.active || !l.is_visible) continue;
    stats.active++;
    if (!prefs.categories.includes(l.category)) continue;
    stats.category++;
    if (l.terms?.length && !l.terms.some(t => prefs.terms.includes(t))) continue;
    stats.term++;

    const title = (l.title || '').toLowerCase();
    if (!prefs.target_titles_must_match.some(k => title.includes(k))) continue;
    if (prefs.exclude_title_keywords.some(k => title.includes(k))) continue;
    stats.title++;

    const locs = (l.locations || []).map(x => x.toLowerCase());
    const locOk =
      locs.length === 0 ||
      (prefs.remote_ok && locs.some(x => x.includes('remote'))) ||
      locs.some(x => prefs.locations_ok.some(ok => x.includes(ok.toLowerCase())));
    if (!locOk) continue;
    // Drop non-US-only listings (feed lists country in location strings)
    if (locs.length && locs.every(x => /canada|uk\b|united kingdom|india|germany|ireland|singapore|australia|japan|mexico|brazil|france|netherlands|poland|israel/.test(x))) continue;
    stats.location++;

    // Sponsorship flag from the feed: skip citizenship-required roles unless
    // the profile says us_citizen === true. (Re-checked against JD text later.)
    if (l.sponsorship === 'U.S. Citizenship is Required' && profile.eligibility.us_citizen !== true) continue;
    if (l.sponsorship === 'Does Not Offer Sponsorship' && profile.eligibility.require_sponsorship === true) continue;
    stats.sponsorship++;

    if (seen[l.id] || queued.has(l.id)) continue;
    stats.new++;
    queue.push({
      id: l.id, company: l.company_name, title: l.title, url: l.url,
      locations: l.locations, terms: l.terms, category: l.category,
      sponsorship: l.sponsorship, date_posted: l.date_posted, scouted_at: new Date().toISOString(),
    });
    queued.add(l.id);
  }

  saveState('queue', queue);
  saveState('seen', seen);
  log(`scout: active=${stats.active} → category=${stats.category} → term=${stats.term} → title=${stats.title} → location=${stats.location} → sponsorship=${stats.sponsorship}; NEW queued=${stats.new} (queue total=${queue.length})`);
  return stats;
}

if (import.meta.url === `file://${process.argv[1]}`) await scout();
