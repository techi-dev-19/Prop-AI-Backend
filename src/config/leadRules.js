/**
 * PropAI lead rules — one place for the thresholds the whole CRM uses.
 *
 *  - A contact becomes a LEAD once they have replied (WhatsApp or email) and
 *    their AI conversation score is above LEAD_SCORE (30).
 *  - A lead is HOT when the score is above HOT_SCORE (60).
 *  - A lead becomes a VISIT LEAD as soon as a site visit is booked (the AI
 *    books it on WhatsApp, or the broker adds one manually).
 */
const LEAD_SCORE = 30;
const HOT_SCORE = 60;

/** Score → temperature used on Lead.status and LeadScore.level. */
function levelForScore(score) {
  const value = Number(score) || 0;
  if (value > HOT_SCORE) return 'hot';
  if (value > LEAD_SCORE) return 'warm';
  return 'cold';
}

/** Lead type shown in Qualified Leads: 'visit' | 'hot' | 'lead' | 'contact'. */
function leadTypeFor({ score, hasVisit, replied }) {
  if (hasVisit) return 'visit';
  if (!replied) return 'contact';
  const value = Number(score) || 0;
  if (value > HOT_SCORE) return 'hot';
  if (value > LEAD_SCORE) return 'lead';
  return 'contact';
}

module.exports = { LEAD_SCORE, HOT_SCORE, levelForScore, leadTypeFor };
