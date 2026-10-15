import type { AppEnv } from "../env";

export type OutgoingMail = { to: string; subject: string; text: string };

/**
 * Sends email for the app itself (magic links, admin alerts, the weekly digest later).
 * MAILER=log prints the message to the Worker log, which is what local development uses.
 */
export async function sendMail(env: AppEnv, mail: OutgoingMail): Promise<void> {
  if (env.MAILER === "resend") {
    if (!env.RESEND_API_KEY) throw new Error("MAILER=resend but RESEND_API_KEY is not set");
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [mail.to], subject: mail.subject, text: mail.text }),
    });
    if (!res.ok) throw new Error(`Resend failed: ${res.status} ${await res.text()}`);
    return;
  }
  console.log(`[mail:log] to=${mail.to} subject=${JSON.stringify(mail.subject)}\n${mail.text}`);
}
