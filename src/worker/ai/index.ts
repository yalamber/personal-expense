/**
 * Workers AI, used where the built-in rules run out: reading a statement email no reader
 * understands, and suggesting a category for a line merchant memory knows nothing about.
 *
 * What the model says is checked before it is used (an amount must be in the email, a category
 * must be one of the household's), and every line it reads still waits in Decide for a person.
 * Without the binding (local development without a Cloudflare login), when a call fails, or when
 * the household has turned AI off, these return nothing and the app works as before.
 */
import type { AppEnv } from "../env";

/** Follows a JSON schema reliably and reads Nepali bank English well enough; cheap per email. */
export const AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const TIMEOUT_MS = 25_000;

/** The one method the app uses, so tests can stand in for Workers AI. */
export type AiRunner = { run(model: string, input: unknown): Promise<unknown> };

/** The AI to use for this household, or null when there is none or the family turned it off. */
export function aiFor(env: AppEnv, household: { aiEnabled?: boolean | null } | null | undefined): AiRunner | null {
  if (household && household.aiEnabled === false) return null;
  const ai = (env as { AI?: unknown }).AI as AiRunner | undefined;
  return ai && typeof ai.run === "function" ? ai : null;
}

/** One question with a JSON answer in the given shape, or null when the model fails or times out. */
export async function askJson<T>(ai: AiRunner, system: string, user: string, schema: Record<string, unknown>, maxTokens = 1024): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const call = ai.run(AI_MODEL, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_schema", json_schema: schema },
      max_tokens: maxTokens,
      temperature: 0,
    });
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), TIMEOUT_MS);
    });
    const out = (await Promise.race([call, timeout])) as { response?: unknown } | null;
    const response = out?.response;
    if (response && typeof response === "object") return response as T;
    if (typeof response === "string") {
      const json = response.match(/\{[\s\S]*\}/);
      return json ? (JSON.parse(json[0]) as T) : null;
    }
    return null;
  } catch (err) {
    console.warn(`[ai] ${err instanceof Error ? err.message : String(err)}`);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
