import type { AppEnv, ParseJob } from "./env";
import { app } from "./http/app";
import { handleParseBatch } from "./ingest/consumer";
import { handleInboundEmail } from "./ingest/email";
import { handleScheduled } from "./scheduled";

export default {
  fetch: (request: Request, env: AppEnv, ctx: ExecutionContext) => app.fetch(request, env, ctx),
  email: (message: ForwardableEmailMessage, env: AppEnv) => handleInboundEmail(message, env),
  queue: (batch: MessageBatch<ParseJob>, env: AppEnv) => handleParseBatch(batch, env),
  scheduled: (_controller: ScheduledController, env: AppEnv, ctx: ExecutionContext) => ctx.waitUntil(handleScheduled(env)),
} satisfies ExportedHandler<AppEnv, ParseJob>;
