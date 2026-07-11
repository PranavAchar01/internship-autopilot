// Orchestrator: scout → qualify → apply → report. Run daily by launchd.
import fs from 'node:fs';
import { scout } from './src/scout.mjs';
import { qualify } from './src/qualify.mjs';
import { applyBatch } from './src/apply.mjs';
import { report } from './src/report.mjs';
import { log, p } from './src/lib.mjs';

// single-instance lock: a concurrent run would double-apply
const LOCK = p('state', 'run.lock');
if (fs.existsSync(LOCK)) {
  const pid = Number(fs.readFileSync(LOCK, 'utf8'));
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch {}
  if (alive) { log(`run: another instance (pid ${pid}) is active — exiting`); process.exit(0); }
}
fs.writeFileSync(LOCK, String(process.pid));
process.on('exit', () => { try { fs.unlinkSync(LOCK); } catch {} });

log('══ autopilot run start ══');
try { await scout(); } catch (e) { log(`scout FAILED: ${e.message}`); }
try { await qualify(); } catch (e) { log(`qualify FAILED: ${e.message}`); }
try { await applyBatch({}); } catch (e) { log(`apply FAILED: ${e.message}`); }
try { report(); } catch (e) { log(`report FAILED: ${e.message}`); }
log('══ autopilot run end ══');
