import type { AppEnv } from "../env";

export type OutgoingMail = { to: string; subject: string; text: string };

/** Raised when an email could not be handed to the provider; `code` comes from the provider when it gives one. */
export class MailError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

/** Splits `Family Money <money@leadbase.stream>` into a name and an address. */
export function parseFrom(from: string): { email: string; name?: string } {
  const m = from.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (m) return { email: m[2]!.trim(), name: m[1]!.replace(/^"|"$/g, "").trim() || undefined };
  return { email: from.trim() };
}

/**
 * Sends email for the app itself (sign-in links now, alerts and the weekly digest later).
 *
 *  - MAILER=cloudflare uses the Worker's `send_email` binding (Cloudflare Email Service). The
 *    sender must be on a domain with Email Routing enabled. On the Workers Free plan the
 *    recipient must be a verified destination address in Email Routing; with Email Sending
 *    onboarded (Workers Paid) any recipient works.
 *  - MAILER=resend sends through Resend with RESEND_API_KEY.
 *  - MAILER=log prints the message to the Worker log, for local development.
 */
export async function sendMail(env: AppEnv, mail: OutgoingMail): Promise<void> {
  if (env.MAILER === "cloudflare") {
    if (!env.EMAIL) throw new MailError("MAILER=cloudflare but the EMAIL send_email binding is missing", "E_NO_BINDING");
    try {
      const sender = parseFrom(env.MAIL_FROM);
      const from = sender.name ? { email: sender.email, name: sender.name } : sender.email;
      await env.EMAIL.send({ to: mail.to, from, subject: mail.subject, text: mail.text });
    } catch (err) {
      const e = err as { code?: string; message?: string };
      throw new MailError(e.message ?? String(err), e.code);
    }
    return;
  }
  if (env.MAILER === "resend") {
    if (!env.RESEND_API_KEY) throw new MailError("MAILER=resend but RESEND_API_KEY is not set", "E_NO_KEY");
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [mail.to], subject: mail.subject, text: mail.text }),
    });
    if (!res.ok) throw new MailError(`Resend failed: ${res.status} ${await res.text()}`, String(res.status));
    return;
  }
  console.log(`[mail:log] to=${mail.to} subject=${JSON.stringify(mail.subject)}\n${mail.text}`);
}
