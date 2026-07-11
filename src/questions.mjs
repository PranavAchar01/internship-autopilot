// Question bank: maps a form-field label to an answer derived from
// profile.yml. Returns { value, kind } or null (no mapping → if the field is
// required, the application goes to the review queue; if optional, skipped).
// kind: 'text' | 'file' | 'bool' | 'option' | 'decline' | 'date' | 'skip'

const yn = (v) => (v === true ? 'Yes' : v === false ? 'No' : null);

// Term → typical internship window (month names for date dropdowns)
function termWindow(job) {
  const t = (job?.terms?.[0] || 'Summer 2027');
  const year = t.match(/20\d\d/)?.[0] || '2027';
  if (/fall/i.test(t)) return { sm: 'September', sy: year, em: 'December', ey: year };
  if (/winter/i.test(t)) return { sm: 'January', sy: year, em: 'March', ey: year };
  if (/spring/i.test(t)) return { sm: 'February', sy: year, em: 'May', ey: year };
  return { sm: 'June', sy: year, em: 'September', ey: year };
}

export function answerFor(labelRaw, profile, job = null) {
  const l = labelRaw.toLowerCase().replace(/\s+/g, ' ').trim();
  const c = profile.candidate, e = profile.eligibility, a = profile.answers, ed = profile.education;
  const T = (v) => (typeof v === 'string' && v.includes('REQUIRED_TODO') ? null : v);
  const w = termWindow(job);

  if (/prior government employment|worked for.*government/.test(l))
    return a.prior_government_employment ? { kind: 'option', value: a.prior_government_employment } : null;
  if (/available for a full[- ]time internship|full[- ]time \(?40/.test(l))
    return a.available_full_time_internship ? { kind: 'option', value: a.available_full_time_internship } : null;

  // Internship window questions (dropdown pairs or free text)
  if (/start date.*month|month.*start date/.test(l)) return { kind: 'option', value: w.sm };
  if (/start date.*year|year.*start date/.test(l)) return { kind: 'option', value: w.sy };
  if (/end date.*month|month.*end date/.test(l)) return { kind: 'option', value: w.em };
  if (/end date.*year|year.*end date/.test(l)) return { kind: 'option', value: w.ey };
  if (/available for (an )?internship|target internship dates|internship (dates|availability|period|timeframe)|dates? (are you|of) availab/.test(l))
    return { kind: 'text', value: `${w.sm} ${w.sy} – ${w.em} ${w.ey} (flexible to the team's timeline)` };
  if (/how (long|many (weeks|months)).*(intern|available)/.test(l)) return { kind: 'text', value: '12 weeks, flexible' };

  if (/programming languages|languages.*proficient|technical skills/.test(l))
    return { kind: 'text', value: 'Python, TypeScript/JavaScript, Java, SQL' };
  if (/outstanding offers|competing (offers|deadlines)|other (offers|deadlines)/.test(l)) return { kind: 'text', value: 'No' };
  if (/background check/.test(l)) return { kind: 'option', value: 'Yes' };
  if (/return to (a |your )?degree|degree-seeking program|returning to school/.test(l)) return b(true);
  if (/area of software engineering|which (software )?team/.test(l))
    return { kind: 'option', value: a.swe_interest_area || 'Full-stack Development', fallback: 'Full-stack' };
  if (/work availability|hours per week|full.?time or part.?time/.test(l))
    return a.available_full_time_internship ? { kind: 'option', value: 'Full Time', fallback: 'Full-Time' } : null;
  if (/what interests you/.test(l)) return { kind: 'freetext', value: a.why_company_fallback };
  if (/specify details from your answer above|referrer.?s name|job board name/.test(l))
    return { kind: 'text', value: 'Simplify (job board)' };

  // Identity
  if (/^(legal )?first name/.test(l)) return t(c.first_name);
  if (/^(legal )?last name|surname|family name/.test(l)) return t(c.last_name);
  if (/^(full |legal )?name$|^your name/.test(l)) return t(c.full_name);
  if (/preferred (first )?name/.test(l)) return { kind: 'skip' };
  if (/e-?mail/.test(l)) return t(c.email);
  if (/phone|mobile/.test(l)) {
    if (/extension/.test(l)) return { kind: 'skip' };
    if (/device|type/.test(l)) return { kind: 'option', value: 'Mobile', fallback: 'Cell' };
    if (/country|code/.test(l)) return { kind: 'option', value: 'United States of America (+1)', fallback: 'United States' };
    return t(c.phone);
  }
  if (/pronoun/.test(l)) return { kind: 'skip' };

  // Files
  if (/resume|cv\b|curriculum/.test(l) && !/cover/.test(l)) return { kind: 'file', value: c.resume_pdf };
  if (/cover letter/.test(l))
    return job?._coverPdf ? { kind: 'cover', file: job._coverPdf, text: job._coverText } : { kind: 'skip' };

  // Links
  if (/linkedin/.test(l)) return t(c.linkedin);
  if (/github|git hub/.test(l)) return t(c.github);
  if (/portfolio|personal (web)?site|website|other url|blog/.test(l)) return t(c.website);

  // Location
  if (/current (location|city)|^location|city, state|where (are you|do you) (currently )?(located|reside|live)/.test(l))
    return { kind: 'autocomplete', value: `${c.city}, ${c.state}` };
  if (/^city$/.test(l)) return t(c.city);
  if (/^state|province/.test(l)) return { kind: 'option', value: c.state };
  if (/zip|postal/.test(l)) return t(T(c.zip));
  if (/street|address line|^address/.test(l)) return t(T(c.street_address));
  if (/^country/.test(l)) return { kind: 'option', value: 'United States' };

  // Education
  if (/school|university|college|institution/.test(l)) return { kind: 'autocomplete', value: ed.school, fallback: 'Other' };
  // bare stem substring-matches "Bachelor's", "Bachelor's Degree", "Bachelors"
  if (/degree/.test(l)) return { kind: 'option', value: "Bachelor's", fallback: 'Bachelor' };
  if (/level of education|education (are )?you (are )?pursuing/.test(l)) return { kind: 'option', value: 'Undergrad', fallback: 'Bachelor' };
  if (/major|discipline|field of study|area of study/.test(l)) return { kind: 'option', value: ed.major, fallback: 'Computer Science' };
  if (/gpa/.test(l)) return t(ed.gpa);
  if (/graduat/.test(l)) {
    const gm = T(ed.expected_grad_month), gy = T(ed.expected_grad_year);
    if (!gy) return null;
    return { kind: 'date', value: `${gm || 'May'} ${gy}`, month: gm || 'May', year: String(gy) };
  }
  if (/currently (a student|enrolled)/.test(l)) return b(ed.currently_enrolled);

  // Eligibility / legal — never guessed; null until profile filled
  if (/sponsor/.test(l)) return b(T(e.require_sponsorship));
  if (/authoriz|legally (able|permitted|entitled) to work|eligible to work|right to work/.test(l)) {
    // multi-option work-auth questions distinguish visa vs citizen/GC — pick
    // the citizen option, never the first "Yes" (which is often the visa one)
    if (e.us_citizen === true) return { kind: 'option', value: 'Citizen', fallback: 'Yes' };
    return b(T(e.authorized_to_work_us));
  }
  if (/u\.?s\.? citizen/.test(l)) return b(T(e.us_citizen));
  if (/employment eligibility|work status|citizenship status/.test(l))
    return e.us_citizen === true ? { kind: 'option', value: 'U.S. Citizen', fallback: 'Citizen' } : null;
  if (/18 years|age of 18|at least 18/.test(l)) {
    // computed from DOB at answer time — never misstated
    if (!e.date_of_birth) return null;
    const dob = new Date(e.date_of_birth);
    return b(new Date(dob.getFullYear() + 18, dob.getMonth(), dob.getDate()) <= new Date());
  }
  if (/date of birth|birth ?date/.test(l)) {
    if (!e.date_of_birth) return null;
    const [y, m, d] = e.date_of_birth.split('-');
    return { kind: 'text', value: `${m}/${d}/${y}` };
  }
  if (/transcript/.test(l)) return c.transcript_pdf ? { kind: 'file', value: c.transcript_pdf } : { kind: 'skip' };
  if (/felon|convict|criminal/.test(l)) return b(e.felony_disclosure);
  if (/security clearance/.test(l)) return { kind: 'option', value: e.security_clearance, fallback: 'None' };
  // Export-control "U.S. person" definitions include citizens — answerable
  // only when citizenship is affirmed in the profile
  if (/export control|itar|u\.?s\.? person/.test(l)) return e.us_citizen === true ? { kind: 'option', value: 'Yes' } : null;
  if (/mathematics competitions|math (olympiad|competition)/.test(l))
    return { kind: 'option', value: 'None of the above', fallback: 'No' };
  if (/hedge fund|proprietary trading/.test(l))
    return { kind: 'freetext', value: 'Yes — AI research internships at UC Santa Cruz (AIEA Lab) and UC Merced (YUCCA Lab), and an engineering internship at Opterra Energy Solutions; none at a hedge fund or proprietary trading firm.' };
  if (/in.person for \d+ weeks|willing to work in.person|onsite full.time|accommodate an onsite/.test(l))
    return a.available_full_time_internship ? { kind: 'option', value: a.available_full_time_internship } : null;
  if (/location preference/.test(l)) return { kind: 'option', value: 'California', fallback: 'San Francisco' };
  if (/related to any current|relatives? (working|employed)/.test(l)) return { kind: 'option', value: 'No' };

  // EEO / demographics → decline
  if (/gender identity|^gender/.test(l)) return { kind: 'decline', value: a.gender };
  if (/hispanic|latino/.test(l)) return { kind: 'decline', value: a.hispanic_latino };
  if (/race|ethnic/.test(l)) return { kind: 'decline', value: a.race_ethnicity };
  if (/veteran/.test(l)) return { kind: 'decline', value: a.veteran_status };
  if (/disability|disabled/.test(l)) return { kind: 'decline', value: a.disability_status };
  if (/transgender|sexual orientation|lgbt/.test(l)) return { kind: 'decline', value: 'Decline to self-identify' };

  // Logistics
  if (/how did you (hear|find|learn)/.test(l)) return { kind: 'option', value: a.how_did_you_hear, fallback: 'Other' };
  if (/relocat/.test(l)) return { kind: 'option', value: a.willing_to_relocate };
  if (/(start date|available to (start|begin)|availability|earliest.*start)/.test(l))
    return t(profile.preferences.earliest_start);
  if (/salary|compensation|pay expectation|desired pay|hourly rate/.test(l)) return t(a.salary_expectation);
  if (/notice period/.test(l)) return t('Available immediately');
  if (/previously (worked|been employed)|former employee|ever worked (at|for)/.test(l)) return b(false);
  if (/referred|referral|know anyone|current employees? you know/.test(l)) return t('No');
  if (/agree|acknowledge|consent|certify|privacy (policy|notice)|terms/.test(l)) return { kind: 'consent' };

  // Free text
  if (/why (do you want|are you interested|.*this (role|position|company))|motivat|interest(ed)? in (this|the)|good fit|why.*join|tell us about yourself|about you\b/.test(l))
    return { kind: 'freetext', value: a.why_company_fallback };
  if (/anything else|additional information|comments/.test(l)) return { kind: 'skip' };

  return null;

  function t(v) { return v == null ? null : { kind: 'text', value: String(v) }; }
  function b(v) { const s = yn(v); return s == null ? null : { kind: 'bool', value: s }; }
}

// Given an answer and the visible options of a select/radio group, choose the
// option text to pick. Returns null if nothing safely matches.
export function pickOption(ans, options) {
  const norm = (s) => s.toLowerCase().trim();
  const opts = options.map((o) => ({ raw: o, n: norm(o) }));
  const find = (pred) => opts.find(pred)?.raw ?? null;

  if (ans.kind === 'bool') {
    return ans.value === 'Yes'
      ? find((o) => /^yes\b/.test(o.n))
      : find((o) => /^no\b/.test(o.n) && !/^not/.test(o.n));
  }
  if (ans.kind === 'decline') {
    return (
      find((o) => norm(ans.value) === o.n) ||
      find((o) => /decline|don'?t wish|do not wish|prefer not|not (to )?(answer|say|disclose)|i don'?t want/.test(o.n)) ||
      null
    );
  }
  // exact → contains → fallback contains
  return (
    find((o) => o.n === norm(ans.value)) ||
    find((o) => o.n.includes(norm(ans.value)) || norm(ans.value).includes(o.n)) ||
    (ans.fallback ? find((o) => o.n.includes(norm(ans.fallback))) : null) ||
    (ans.kind === 'bool' ? null : null)
  );
}
