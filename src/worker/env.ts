/**
 * Worker bindings and secrets.
 *
 * `Env` comes from the generated `worker-configuration.d.ts` (run `npm run cf:types`
 * after changing wrangler.jsonc). Vars are typed there as string literals, which is
 * too narrow for comparisons, so we widen them and add the secrets from `.dev.vars`
 * or `wrangler secret put`.
 */
export type AppEnv = { [K in keyof Env]: Env[K] extends string ? string : Env[K] } & {
  /**
   * Signs session cookies. Optional: when unset, a random secret is generated once and kept in
   * the app_settings table. Set it as a Worker secret to manage it yourself.
   */
  AUTH_SECRET?: string;
  /** Only needed when MAILER=resend. */
  RESEND_API_KEY?: string;
  /** Optional. When bound, parse jobs go through the queue; otherwise they run inline. */
  PARSE_QUEUE?: Queue<ParseJob>;
};

/** A queue message asking the consumer to process one stored statement email. */
export type ParseJob = {
  kind: "parse-statement-email";
  statementEmailId: string;
  householdId: string;
};
