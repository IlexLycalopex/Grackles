/**
 * Transactional email through Resend.
 *
 * There is no SDK here on purpose: sending is one POST, and the dependency
 * would earn its place only if we started reading delivery state back.
 *
 * The API key is sending-only and restricted to grackles.co.uk, so the worst a
 * leak buys someone is mail from our own domain — but it is still a server
 * secret, which is why it is not named with the PUBLIC_ prefix that Astro uses
 * to decide what may reach the browser.
 */

import { env } from './env';

const ENDPOINT = 'https://api.resend.com/emails';

/** Long enough for a slow day at Resend, short enough not to hang an invite. */
const SEND_TIMEOUT_MS = 10_000;

/** Falls back to the domain Resend has verified for us. */
const DEFAULT_FROM = 'Grackles <invites@grackles.co.uk>';

/**
 * Sending never throws. A failed send must not lose an invitation that the
 * database has already accepted, so the caller gets a reason it can show
 * beside the copyable link rather than an exception that loses the row.
 */
export type SendResult = { ok: true; id: string } | { ok: false; reason: string };


/** "a", "a and b", "a, b and c" — for reading aloud, not for parsing. */
function listSentence(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function send(message: {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}): Promise<SendResult> {
  const key = env('RESEND_API_KEY');

  // Not configured is a normal state, not a fault: the app ran for months
  // without it and the copy-the-link path still works. Say so plainly so the
  // notice on the page is actionable rather than a generic failure.
  if (!key) return { ok: false, reason: 'RESEND_API_KEY is not set' };

  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: env('INVITE_FROM_EMAIL') ?? DEFAULT_FROM,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(message.replyTo ? { reply_to: message.replyTo } : {}),
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });

    const body = await response.json().catch(() => null);

    if (!response.ok) {
      // Resend puts the useful part in `message`; fall back to the status so a
      // proxy error or an HTML error page still says something.
      const reason = body?.message ?? `Resend returned ${response.status}`;
      console.error('Resend send failed', { status: response.status, body });
      return { ok: false, reason };
    }

    return { ok: true, id: body?.id ?? '' };
  } catch (cause) {
    console.error('Resend send threw', cause);
    return { ok: false, reason: 'the mail service could not be reached' };
  }
}

/**
 * The invitation itself. The link is the whole message — everything else is
 * there so the recipient can tell it apart from a phishing attempt: who asked,
 * what they are being let into, and what it lets them do.
 */
export async function sendInviteEmail(invite: {
  to: string;
  inviteUrl: string;
  /**
   * Null on a creation-only invitation, which lets somebody start a project
   * of their own without joining anybody else's. The people console sends
   * those; a project's settings page never does.
   */
  workspaceName: string | null;
  appName: string | null;
  role: string;
  invitedBy: string;
  expiresAt: string;
  /** Apps the invitation also lets them start a project of, if any. */
  grantedApps?: string[];
}): Promise<SendResult> {
  const expires = new Date(invite.expiresAt).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  // A workspace is often named after the app it belongs to, and "Listening
  // Party (Listening Party)" reads like a mistake. Naming it twice only helps
  // when the two actually differ.
  const what =
    invite.workspaceName === null
      ? null
      : invite.workspaceName === invite.appName
        ? invite.workspaceName
        : `${invite.workspaceName} (${invite.appName})`;
  const capability =
    what === null
      ? ''
      : invite.role === 'viewer'
        ? 'You will be able to read everything and change nothing.'
        : invite.role === 'editor'
          ? 'You will be able to read and change entries.'
          : 'You will be able to read, change, and manage who else has access.';

  // Being let into someone's project and being able to run one of your own are
  // separate things, and an invitation can carry either or both. Saying so
  // matters most when it carries only the second: without this the mail reads
  // as an invitation to a project that is never mentioned again.
  const granted = invite.grantedApps ?? [];
  const grant =
    granted.length === 0
      ? ''
      : what === null
        ? `It lets you start your own: ${listSentence(granted)}.`
        : `It also lets you start your own: ${listSentence(granted)}.`;

  // With no project there is no role to name, and "as viewer" of nothing
  // would read as a mistake. The same opening, plain and marked up.
  const opening = {
    text:
      what === null
        ? `${invite.invitedBy} has invited you to Grackles.`
        : `${invite.invitedBy} has invited you to ${what} on Grackles, as ${invite.role}.`,
    html:
      what === null
        ? `<strong>${escapeHtml(invite.invitedBy)}</strong> has invited you to <strong>Grackles</strong>.`
        : `<strong>${escapeHtml(invite.invitedBy)}</strong> has invited you to
        <strong>${escapeHtml(what)}</strong>, as <strong>${escapeHtml(invite.role)}</strong>.`,
  };

  const text = [
    opening.text,
    ...[capability, grant].filter(Boolean),
    '',
    'Open this link to accept:',
    invite.inviteUrl,
    '',
    `The invitation expires on ${expires}.`,
    'If you were not expecting this, ignore it — nothing happens until the link is opened.',
  ].join('\n');

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-weight:300;line-height:1.6;color:#1e1d2e;max-width:34rem;margin:0 auto;padding:2rem 1.5rem">
      <p style="font-family:Georgia,serif;font-size:1.5rem;margin:0 0 1.5rem">Grackles</p>
      <p style="margin:0 0 1rem">
        ${opening.html}
      </p>
      <p style="margin:0 0 1.5rem">
        ${[capability, escapeHtml(grant)].filter(Boolean).join(' ')}
      </p>
      <p style="margin:0 0 1.5rem">
        <a href="${escapeHtml(invite.inviteUrl)}"
           style="display:inline-block;background:#1e1d2e;color:#eae7e0;padding:.75rem 1.5rem;text-decoration:none;border-radius:2px">
          Accept the invitation
        </a>
      </p>
      <p style="margin:0 0 1.5rem;font-size:.875rem;color:#8a8578">
        Or paste this into your browser:<br />
        <span style="word-break:break-all">${escapeHtml(invite.inviteUrl)}</span>
      </p>
      <hr style="border:none;border-top:1px solid #c8c3b6;margin:2rem 0" />
      <p style="margin:0;font-size:.875rem;color:#8a8578">
        The invitation expires on ${expires}. If you were not expecting this, ignore it — nothing
        happens until the link is opened.
      </p>
    </div>
  `.trim();

  return send({
    to: invite.to,
    subject: invite.workspaceName === null
      ? `${invite.invitedBy} invited you to Grackles`
      : `${invite.invitedBy} invited you to ${invite.workspaceName} on Grackles`,
    html,
    text,
    // So a reply reaches the person who invited them rather than a dead
    // no-reply address.
    replyTo: invite.invitedBy,
  });
}
