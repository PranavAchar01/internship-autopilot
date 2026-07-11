// Move review-queue items whose reason matches a pattern back into the
// qualified list (e.g. after a detection fix or after filling profile TODOs).
//   node src/requeue.mjs 'captcha|unanswerable'
import { loadState, saveState, log } from './lib.mjs';

const pattern = new RegExp(process.argv[2] || 'unanswerable_required', 'i');
const review = loadState('review', []);
const qualified = loadState('qualified', []);
const qIds = new Set(qualified.map((q) => q.id));

const keep = [];
let moved = 0;
for (const r of review) {
  if (pattern.test(r.reason || '')) {
    // Removing it from review is what makes apply retry it; only re-add to
    // qualified if it isn't still there.
    if (!qIds.has(r.id)) {
      const { reason, missing, screenshot, queuedAt, ...job } = r;
      qualified.push(job);
      qIds.add(job.id);
    }
    moved++;
  } else keep.push(r);
}
saveState('review', keep);
saveState('qualified', qualified);
log(`requeue: moved ${moved} items matching /${pattern.source}/ back to qualified (review left=${keep.length})`);
