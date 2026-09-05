import type { JobPublisher } from "@rakazo/adapter-kit";
import { runContinueJob } from "@rakazo/adapter-kit";
import type { EncryptedSecretStore } from "@rakazo/adapters";
import { hasValidBearerToken, timingSafeStringEqual } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { Hono } from "hono";
import { WEBHOOK_SECRET_KIND } from "./webhook.js";

/**
 * factory-bridge.ts — Rakazo ↔ praxis-engine webhook bridge
 *
 * Outbound: POST /api/v1/bots/:botId/factory-build lets a bot action
 * trigger a praxis-engine factory build. Authenticated the same way as
 * the existing inbound webhook (webhook.ts) — a Bearer token matching the
 * bot's own webhook secret — so this reuses existing secret infrastructure
 * instead of inventing new auth.
 *
 * Inbound: POST /api/v1/factory-callback receives the job result from
 * praxis-engine (once the factory pipeline finishes) and posts it into the
 * originating thread.
 *
 * Callback auth note: praxis-engine's completion delivery
 * (`deliverRakazoCallback` in praxis-server.js) does a plain `fetch(url, ...)`
 * against whatever `callback_url` we handed it on the outbound leg — it does
 * NOT attach an `x-webhook-secret` (or any) header to that POST. So a check
 * that only looked at a header would reject every real callback. Instead we
 * embed the shared secret as a query param on the `callback_url` we generate
 * (`?rk_secret=...`) — a value only Rakazo constructs and only praxis-engine
 * echoes back verbatim — and verify that. The header check is kept too, in
 * case a future praxis-engine version starts sending it; either is accepted.
 */

const CALLBACK_SECRET_QUERY_PARAM = "rk_secret";

export type FactoryBuildEvents = {
  sendUserMessage(input: {
    spaceId: string;
    threadId: string;
    botId: string;
    userId: string;
    blocks: Array<{ kind: "text"; text: string }>;
    prompt: string;
    trigger: "webhook";
    clientNonce?: string;
  }): Promise<{ messageId: string; runId: string | null; seq: number }>;
};

export type FactoryBridgeDeps = {
  prisma: PrismaClient;
  secrets: EncryptedSecretStore;
  events: FactoryBuildEvents;
  jobs: JobPublisher;
  /** Base URL of praxis-engine's factory API, e.g. http://127.0.0.1:3333 */
  praxisEngineUrl: string;
  /** Shared secret with praxis-engine (RAKAZO_WEBHOOK_SECRET in both .env files). */
  praxisWebhookSecret: string | undefined;
  /** This Rakazo API's own public base URL, used to build the callback_url praxis-engine posts back to. */
  publicApiUrl: string;
};

export function factoryCallbackPath(): string {
  return "/api/v1/factory-callback";
}

export function factoryBuildPath(botId: string): string {
  return `/api/v1/bots/${botId}/factory-build`;
}

export interface FactoryWebhookRequest {
  task: string;
  project_path?: string;
  callback_url: string;
  thread_id: string;
  metadata: { botId: string };
}

/** Build the outbound payload POSTed to praxis-engine's POST /api/factory/webhook/rakazo. */
export function buildFactoryWebhookRequest(input: {
  task: string;
  projectPath?: string;
  threadId: string;
  botId: string;
  publicApiUrl: string;
  /** Shared secret embedded on the callback_url so the callback leg is self-authenticating
   *  (see the callback-auth note in the file header). Omitted entirely when unset. */
  praxisWebhookSecret?: string;
}): FactoryWebhookRequest {
  const base = `${input.publicApiUrl.replace(/\/$/, "")}${factoryCallbackPath()}`;
  const callbackUrl = input.praxisWebhookSecret
    ? `${base}?${CALLBACK_SECRET_QUERY_PARAM}=${encodeURIComponent(input.praxisWebhookSecret)}`
    : base;
  return {
    task: input.task,
    project_path: input.projectPath,
    callback_url: callbackUrl,
    thread_id: input.threadId,
    metadata: { botId: input.botId },
  };
}

/**
 * Trigger a factory build in praxis-engine. Resolves once praxis-engine has
 * accepted and queued the job (HTTP 202), or throws with the error message
 * praxis-engine returned.
 */
export async function triggerFactoryBuild(
  deps: Pick<FactoryBridgeDeps, "praxisEngineUrl" | "praxisWebhookSecret">,
  payload: FactoryWebhookRequest,
): Promise<{ jobId: string; status: string }> {
  const res = await fetch(`${deps.praxisEngineUrl.replace(/\/$/, "")}/api/factory/webhook/rakazo`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webhook-secret": deps.praxisWebhookSecret ?? "",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  const data = (await res.json().catch(() => ({}))) as {
    jobId?: string;
    status?: string;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(data.error ?? `praxis-engine returned ${res.status}`);
  }
  return { jobId: data.jobId ?? "", status: data.status ?? "started" };
}

export interface FactoryCallbackPayload {
  job_id: string;
  status: string;
  output?: string;
  artifacts?: Array<{ name: string; type?: string; url?: string }>;
  thread_id?: string;
}

/** Format a praxis-engine job-completion callback into a thread message. */
export function formatFactoryResultMessage(payload: FactoryCallbackPayload): string {
  const icon = payload.status === "done" ? "✅" : payload.status === "failed" ? "❌" : "ℹ️";
  const lines = [`${icon} Factory job \`${payload.job_id}\` ${payload.status}.`];
  if (payload.output?.trim()) {
    lines.push("", payload.output.trim().slice(0, 4000));
  }
  if (payload.artifacts?.length) {
    lines.push(
      "",
      "Artifacts:",
      ...payload.artifacts.map((a) => `- ${a.name}${a.url ? ` (${a.url})` : ""}`),
    );
  }
  return lines.join("\n");
}

export function mountFactoryBridgeRoutes(app: Hono, deps: FactoryBridgeDeps) {
  // ── Outbound: a bot action requests a factory build ──────────────────────
  app.post("/api/v1/bots/:botId/factory-build", async (c) => {
    const unauthorized = () => c.json({ error: "Unauthorized" }, 401);
    const botId = c.req.param("botId");
    const authorization = c.req.header("authorization");

    const bot = await deps.prisma.bot.findUnique({
      where: { id: botId, archivedAt: null },
      select: {
        id: true,
        spaceId: true,
        userId: true,
        webhookSecretId: true,
        thread: { select: { id: true } },
      },
    });
    // Same 401 for missing bot, missing secret, and bad bearer — bot ids stay non-enumerable.
    if (!bot?.thread || !bot.webhookSecretId) return unauthorized();

    const secret = await deps.prisma.secret.findUnique({
      where: { id: bot.webhookSecretId },
      select: { id: true, ciphertext: true, kind: true, userId: true, spaceId: true },
    });
    if (!secret || secret.kind !== WEBHOOK_SECRET_KIND) return unauthorized();
    if (secret.userId !== bot.userId || secret.spaceId !== bot.spaceId) return unauthorized();

    let expected: string;
    try {
      expected = deps.secrets.load(secret.ciphertext, secret.id);
    } catch {
      return unauthorized();
    }
    if (!hasValidBearerToken(authorization, expected)) return unauthorized();

    const body = (await c.req.json().catch(() => null)) as {
      task?: unknown;
      project_path?: unknown;
    } | null;
    const task = typeof body?.task === "string" ? body.task.trim() : "";
    if (!task) return c.json({ error: "task is required" }, 400);
    const projectPath = typeof body?.project_path === "string" ? body.project_path : undefined;

    const payload = buildFactoryWebhookRequest({
      task,
      projectPath,
      threadId: bot.thread.id,
      botId: bot.id,
      publicApiUrl: deps.publicApiUrl,
      praxisWebhookSecret: deps.praxisWebhookSecret,
    });

    try {
      const result = await triggerFactoryBuild(deps, payload);
      return c.json({ ok: true, jobId: result.jobId, status: result.status }, 202);
    } catch (error) {
      getLogger().error("factory-build trigger error", error as Error);
      return c.json({ ok: false, error: (error as Error).message }, 502);
    }
  });

  // ── Inbound: praxis-engine posts the job result back here ────────────────
  app.post(factoryCallbackPath(), async (c) => {
    // praxis-engine's callback delivery doesn't attach a header (see file-header
    // note), so the query param embedded in the callback_url is the live check;
    // the header is accepted too in case that ever changes.
    const provided = c.req.header("x-webhook-secret") ?? c.req.query(CALLBACK_SECRET_QUERY_PARAM);
    if (!deps.praxisWebhookSecret || !timingSafeStringEqual(provided, deps.praxisWebhookSecret)) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const body = (await c.req.json().catch(() => null)) as FactoryCallbackPayload | null;
    if (!body?.job_id || !body.status || !body.thread_id) {
      return c.json({ error: "job_id, status, and thread_id are required" }, 400);
    }

    const thread = await deps.prisma.thread.findUnique({
      where: { id: body.thread_id },
      select: { id: true, spaceId: true, botId: true, userId: true },
    });
    if (!thread?.botId) {
      return c.json({ error: "Unknown thread" }, 404);
    }

    const prompt = formatFactoryResultMessage(body);
    const sent = await deps.events.sendUserMessage({
      spaceId: thread.spaceId,
      threadId: thread.id,
      botId: thread.botId,
      userId: thread.userId,
      blocks: [{ kind: "text", text: prompt }],
      prompt,
      trigger: "webhook",
      clientNonce: `factory-callback:${body.job_id}:${body.status}`,
    });

    if (sent.runId) {
      await deps.jobs.enqueue(runContinueJob(sent.runId)).catch((error) => {
        getLogger().error("factory-callback run enqueue error", error as Error);
      });
    }

    return c.json({ ok: true, messageId: sent.messageId, runId: sent.runId, seq: sent.seq });
  });
}
