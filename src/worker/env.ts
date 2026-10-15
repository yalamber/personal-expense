/**
 * Worker bindings and secrets.
 *
 * `Env` comes from the generated `worker-configuration.d.ts` (run `npm run cf:types`
 * after changing wrangler.jsonc). Vars are typed there as string literals, which is
 * too narrow for comparisons, so we widen them and add the secrets from `.dev.vars`
 * or `wrangler secret put`.
 */
export type AppEnv = { [K in keyof Env]: Env[K] extends string ? string : Env[K] } & {
  /** Signs magic-link and session tokens. Required. */
  AUTH_SECRET: string;
  /** Only needed when MAILER=resend. */
  RESEND_API_KEY?: string;
};

/** A queue message asking the consumer to process one stored statement email. */
export type ParseJob = {
  kind: "parse-statement-email";
  statementEmailId: string;
  householdId: string;
};
