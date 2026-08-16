import type { APIRoute } from 'astro';

export const prerender = false;

/**
 * Cancelling a job.
 *
 * Sets one flag. The next tick sees it, ends the job and gives the envelope
 * back; calls already in flight finish and settle, because those tokens are
 * paid for either way and abandoning them would only lose the answer.
 *
 * Who may cancel is decided by ai_cancel_job — payer, actor, or platform admin
 * — rather than here, so an admin stopping somebody else's runaway batch and an
 * owner stopping their own take the identical path. During an incident is the
 * worst possible moment to discover there were two.
 */
export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const { supabase, user } = locals;
  if (!user) return new Response('Sign in first.', { status: 401 });

  const form = await request.formData();
  const jobId = String(form.get('job_id') ?? '');
  const next = String(form.get('next') ?? '/settings/ai');

  if (!jobId) return new Response('No job.', { status: 400 });

  const { error } = await supabase.rpc('ai_cancel_job', { p_job: jobId });

  if (error) {
    // GRK10 covers both "no such job" and "not yours", deliberately: a job id
    // is a uuid somebody either has or does not, and distinguishing the two
    // would confirm the existence of other people's work.
    return new Response(error.code === 'GRK10' ? 'Not found.' : 'That job could not be cancelled.', {
      status: error.code === 'GRK10' ? 404 : 500,
    });
  }

  // Only ever back to a path on this site. `next` arrives from a form field,
  // and a redirect that accepts an absolute URL is an open redirect.
  return redirect(next.startsWith('/') ? next : '/settings/ai', 303);
};
