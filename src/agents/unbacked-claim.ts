// unbacked-claim.ts — a reply must not say work was delegated or done when no tool ran (ADR-068).
//
// A model can answer "I've delegated that" or "I've created those" without calling anything, and an instruction not to
// has not stopped it. Where a turn carries this check and the specialist was never called, the draft is held back and
// the model is made to call it; if the reply still claims work, the owner gets the truth instead.

/** First-person, specialist or passive statements that work was handed on or done. */
const CLAIMS: RegExp[] = [
  /\bI(?:['’](?:ve|m|ll)| have| am| will)?(?:\s+(?:now|just|already|also|successfully|then))?\s+(?:delegat(?:e|ed|ing)|ask(?:ed|ing)? the budget agent|passed|passing|creat(?:e|ed|ing)|added|adding|updated|updating|set(?:ting)? up|saved|saving|proposed|proposing|sent|sending)\b/i,
  /\bthe budget agent (?:will|is|has|now)\b/i,
  /\byou(?:['’]ll| will| should) (?:now )?see (?:a|the) (?:proposal )?card\b/i,
  /\b(?:categories|budgets?|amounts|changes|proposal) (?:are|is|were|was|have been|has been) (?:now |already |all )?(?:set up|created|added|updated|saved|proposed|in place|ready)\b/i,
];
/** A question, an offer, a condition or a denial claims nothing. */
const NOT_A_CLAIM = /\?\s*$|\b(?:no|not|nothing|none|never|cannot|if|once|shall|would you)\b|n['’]t\b/i;

export function claimsUnbackedWork(reply: string): boolean {
  return reply.split(/(?<=[.!?:])\s+|\n+/).some(sentence => !NOT_A_CLAIM.test(sentence) && CLAIMS.some(claim => claim.test(sentence)));
}

/** Shown to the model, never to the owner. */
export const UNBACKED_CLAIM_CORRECTION =
  '[Curia runtime check] Your draft says work was delegated or done, but you called no tool in this turn, so nothing '
  + 'happened. The draft was not sent. Call delegate now to do what the principal asked, then reply only from its result.';

/** Sent instead of a reply that still claims work after the correction. */
export const UNBACKED_CLAIM_REPLY =
  'Nothing was done. I was about to tell you I had handled this, but I never passed it to the budget agent, so nothing '
  + 'was changed or proposed. Please send your request again.';
