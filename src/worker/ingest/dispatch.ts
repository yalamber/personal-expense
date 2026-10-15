import type { AppEnv, ParseJob } from "../env";
import { processStatementEmail } from "./consumer";

/**
 * Hands a stored statement email to the parser.
 *
 * With a PARSE_QUEUE binding the job goes onto the queue (retries and a dead-letter queue come
 * from the queue settings). Without one, it runs after the current request or email event has
 * been answered, via ctx.waitUntil; anything that dies there stays `received` and the nightly
 * cron picks it up again.
 */
export async function dispatchParse(env: AppEnv, ctx: Pick<ExecutionContext, "waitUntil">, job: ParseJob): Promise<void> {
  if (env.PARSE_QUEUE) {
    await env.PARSE_QUEUE.send(job);
    return;
  }
  ctx.waitUntil(
    processStatementEmail(job, env).catch((err) => {
      console.error(`[parse] inline processing failed for ${job.statementEmailId}`, err);
    }),
  );
}
