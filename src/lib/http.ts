/**
 * The two things every API route was writing for itself.
 *
 * Fourteen routes each declared the same `json()` helper, and the five that
 * spend AI money each decided what status a refusal deserved — four different
 * ways. One said 402 for every GRK code, so "you are not the owner" read as
 * "payment required"; three reported a refusal that arrived mid-call (the
 * allowance ran out, the breaker opened) as 502, as though the provider had
 * failed. The rule is now written down once.
 */

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/**
 * The status for a refusal from the AI gates, by its SQLSTATE.
 *
 * 402 where the answer is "there is no money left for this", 429 where it is
 * "not so fast", 503 where the model is down and the breaker said so, 404 for
 * a job that is not yours or not there, and 403 for every other "not here, not
 * you, not now".
 */
export function aiRefusalStatus(code: string | undefined): number {
  switch (code) {
    case 'GRK15':
    case 'GRK16':
    case 'GRK18':
      return 402;
    case 'GRK14':
      return 429;
    case 'GRK1F':
      return 503;
    case 'GRK10':
      return 404;
    default:
      return 403;
  }
}

/**
 * The status for a turn that did not produce an answer: a gate refusing it
 * (anything with a GRK code), the model not being configured, or the provider
 * failing.
 */
export function aiFailureStatus(failure: { code?: string; error: string }): number {
  if (failure.code?.startsWith('GRK')) return aiRefusalStatus(failure.code);
  return failure.error.includes('not configured') ? 503 : 502;
}
