import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildFactoryWebhookRequest,
  factoryCallbackPath,
  type FactoryBridgeDeps,
  formatFactoryResultMessage,
  mountFactoryBridgeRoutes,
  triggerFactoryBuild,
} from "./factory-bridge.js";
import { WEBHOOK_SECRET_KIND } from "./webhook.js";

const BOT_SECRET = "bot-webhook-secret-value-32chars!!";
const PRAXIS_SECRET = "shared-rakazo-praxis-secret-value";

function createDeps(
  overrides: {
    bot?: {
      id: string;
      spaceId: string;
      userId: string;
      webhookSecretId: string | null;
      thread: { id: string } | null;
    } | null;
    secret?: { ciphertext: string; kind: string; userId: string; spaceId: string } | null;
    thread?: { id: string; spaceId: string; botId: string | null; userId: string } | null;
    praxisWebhookSecret?: string | undefined;
  } = {},
): FactoryBridgeDeps & {
  sendUserMessage: ReturnType<typeof vi.fn>;
  enqueue: ReturnType<typeof vi.fn>;
} {
  const bot =
    overrides.bot === undefined
      ? {
          id: "bot-1",
          spaceId: "ws-1",
          userId: "user-1",
          webhookSecretId: "secret-1",
          thread: { id: "thread-1" },
        }
      : overrides.bot;
  const secret =
    overrides.secret === undefined
      ? { ciphertext: "cipher", kind: WEBHOOK_SECRET_KIND, userId: "user-1", spaceId: "ws-1" }
      : overrides.secret;
  const thread =
    overrides.thread === undefined
      ? { id: "thread-1", spaceId: "ws-1", botId: "bot-1", userId: "user-1" }
      : overrides.thread;

  const sendUserMessage = vi.fn(async () => ({ messageId: "msg-1", runId: "run-1", seq: 3 }));
  const enqueue = vi.fn(async () => undefined);

  return {
    prisma: {
      bot: { findUnique: vi.fn(async () => bot) },
      secret: { findUnique: vi.fn(async () => secret) },
      thread: { findUnique: vi.fn(async () => thread) },
    } as unknown as FactoryBridgeDeps["prisma"],
    secrets: { load: () => BOT_SECRET } as unknown as FactoryBridgeDeps["secrets"],
    events: { sendUserMessage },
    jobs: { enqueue } as unknown as FactoryBridgeDeps["jobs"],
    praxisEngineUrl: "http://127.0.0.1:3333",
    praxisWebhookSecret:
      overrides.praxisWebhookSecret === undefined ? PRAXIS_SECRET : overrides.praxisWebhookSecret,
    publicApiUrl: "http://127.0.0.1:3100",
    sendUserMessage,
    enqueue,
  };
}

function mount(deps: FactoryBridgeDeps) {
  const app = new Hono();
  mountFactoryBridgeRoutes(app, deps);
  return app;
}

describe("buildFactoryWebhookRequest", () => {
  it("embeds the shared secret as a query param on callback_url", () => {
    const payload = buildFactoryWebhookRequest({
      task: "build it",
      threadId: "thread-1",
      botId: "bot-1",
      publicApiUrl: "http://127.0.0.1:3100",
      praxisWebhookSecret: PRAXIS_SECRET,
    });
    expect(payload.callback_url).toBe(
      `http://127.0.0.1:3100${factoryCallbackPath()}?rk_secret=${encodeURIComponent(PRAXIS_SECRET)}`,
    );
    expect(payload.thread_id).toBe("thread-1");
    expect(payload.metadata).toEqual({ botId: "bot-1" });
  });

  it("omits the query param entirely when no secret is configured", () => {
    const payload = buildFactoryWebhookRequest({
      task: "build it",
      threadId: "thread-1",
      botId: "bot-1",
      publicApiUrl: "http://127.0.0.1:3100",
    });
    expect(payload.callback_url).toBe(`http://127.0.0.1:3100${factoryCallbackPath()}`);
  });
});

describe("formatFactoryResultMessage", () => {
  it("formats a done result with output and artifacts", () => {
    const message = formatFactoryResultMessage({
      job_id: "job-1",
      status: "done",
      output: "Shipped the feature.",
      artifacts: [{ name: "PR", url: "https://example.test/pr/1" }],
    });
    expect(message).toContain("✅");
    expect(message).toContain("Shipped the feature.");
    expect(message).toContain("PR (https://example.test/pr/1)");
  });

  it("formats a failed result", () => {
    const message = formatFactoryResultMessage({ job_id: "job-1", status: "failed" });
    expect(message).toContain("❌");
  });
});

describe("triggerFactoryBuild", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to praxis-engine's webhook route with the shared secret header", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ jobId: "job-1", status: "started" }), { status: 202 }),
    );
    const payload = buildFactoryWebhookRequest({
      task: "build it",
      threadId: "thread-1",
      botId: "bot-1",
      publicApiUrl: "http://127.0.0.1:3100",
      praxisWebhookSecret: PRAXIS_SECRET,
    });
    const result = await triggerFactoryBuild(
      { praxisEngineUrl: "http://127.0.0.1:3333", praxisWebhookSecret: PRAXIS_SECRET },
      payload,
    );
    expect(result).toEqual({ jobId: "job-1", status: "started" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3333/api/factory/webhook/rakazo",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-webhook-secret": PRAXIS_SECRET }),
      }),
    );
  });

  it("throws praxis-engine's error message on a non-2xx response", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "task is required" }), { status: 400 }),
    );
    const payload = buildFactoryWebhookRequest({
      task: "build it",
      threadId: "thread-1",
      botId: "bot-1",
      publicApiUrl: "http://127.0.0.1:3100",
    });
    await expect(
      triggerFactoryBuild({ praxisEngineUrl: "http://127.0.0.1:3333", praxisWebhookSecret: undefined }, payload),
    ).rejects.toThrow("task is required");
  });
});

describe("outbound HTTP route: POST /api/v1/bots/:botId/factory-build", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ jobId: "job-1", status: "started" }), { status: 202 }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects missing authorization", async () => {
    const deps = createDeps();
    const app = mount(deps);
    const res = await app.request("/api/v1/bots/bot-1/factory-build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "fix the bug" }),
    });
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects the wrong bearer secret", async () => {
    const deps = createDeps();
    const app = mount(deps);
    const res = await app.request("/api/v1/bots/bot-1/factory-build", {
      method: "POST",
      headers: { authorization: "Bearer wrong-secret", "content-type": "application/json" },
      body: JSON.stringify({ task: "fix the bug" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a missing task", async () => {
    const deps = createDeps();
    const app = mount(deps);
    const res = await app.request("/api/v1/bots/bot-1/factory-build", {
      method: "POST",
      headers: { authorization: `Bearer ${BOT_SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("triggers a factory build and returns 202 with the job id", async () => {
    const deps = createDeps();
    const app = mount(deps);
    const res = await app.request("/api/v1/bots/bot-1/factory-build", {
      method: "POST",
      headers: { authorization: `Bearer ${BOT_SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({ task: "fix the bug", project_path: "/root/workspace/some-repo" }),
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, jobId: "job-1", status: "started" });

    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(requestInit.body as string);
    expect(sentBody.task).toBe("fix the bug");
    expect(sentBody.project_path).toBe("/root/workspace/some-repo");
    expect(sentBody.thread_id).toBe("thread-1");
    expect(sentBody.callback_url).toContain(`rk_secret=${encodeURIComponent(PRAXIS_SECRET)}`);
  });

  it("returns 502 when praxis-engine rejects the build", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
    const deps = createDeps();
    const app = mount(deps);
    const res = await app.request("/api/v1/bots/bot-1/factory-build", {
      method: "POST",
      headers: { authorization: `Bearer ${BOT_SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({ task: "fix the bug" }),
    });
    expect(res.status).toBe(502);
  });
});

describe("inbound HTTP route: POST /api/v1/factory-callback", () => {
  it("rejects a request with no secret at all", async () => {
    const deps = createDeps();
    const app = mount(deps);
    const res = await app.request(factoryCallbackPath(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ job_id: "job-1", status: "done", thread_id: "thread-1" }),
    });
    expect(res.status).toBe(401);
    expect(deps.sendUserMessage).not.toHaveBeenCalled();
  });

  it("rejects when RAKAZO_WEBHOOK_SECRET is not configured, even with a matching-looking secret", async () => {
    const deps = createDeps({ praxisWebhookSecret: undefined });
    const app = mount(deps);
    const res = await app.request(`${factoryCallbackPath()}?rk_secret=anything`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ job_id: "job-1", status: "done", thread_id: "thread-1" }),
    });
    expect(res.status).toBe(401);
  });

  it("accepts the secret via the callback_url query param (praxis-engine's actual delivery path)", async () => {
    const deps = createDeps();
    const app = mount(deps);
    const res = await app.request(
      `${factoryCallbackPath()}?rk_secret=${encodeURIComponent(PRAXIS_SECRET)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          job_id: "job-1",
          status: "done",
          output: "All good.",
          thread_id: "thread-1",
        }),
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, messageId: "msg-1", runId: "run-1", seq: 3 });
    expect(deps.sendUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: "bot-1",
        threadId: "thread-1",
        trigger: "webhook",
        prompt: expect.stringContaining("All good."),
      }),
    );
    expect(deps.enqueue).toHaveBeenCalled();
  });

  it("also accepts the secret via the x-webhook-secret header (forward-compatible)", async () => {
    const deps = createDeps();
    const app = mount(deps);
    const res = await app.request(factoryCallbackPath(), {
      method: "POST",
      headers: { "content-type": "application/json", "x-webhook-secret": PRAXIS_SECRET },
      body: JSON.stringify({ job_id: "job-1", status: "failed", thread_id: "thread-1" }),
    });
    expect(res.status).toBe(200);
  });

  it("rejects a wrong secret", async () => {
    const deps = createDeps();
    const app = mount(deps);
    const res = await app.request(`${factoryCallbackPath()}?rk_secret=wrong`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ job_id: "job-1", status: "done", thread_id: "thread-1" }),
    });
    expect(res.status).toBe(401);
    expect(deps.sendUserMessage).not.toHaveBeenCalled();
  });

  it("rejects a payload missing required fields", async () => {
    const deps = createDeps();
    const app = mount(deps);
    const res = await app.request(
      `${factoryCallbackPath()}?rk_secret=${encodeURIComponent(PRAXIS_SECRET)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "done" }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown thread", async () => {
    const deps = createDeps({ thread: null });
    const app = mount(deps);
    const res = await app.request(
      `${factoryCallbackPath()}?rk_secret=${encodeURIComponent(PRAXIS_SECRET)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ job_id: "job-1", status: "done", thread_id: "unknown-thread" }),
      },
    );
    expect(res.status).toBe(404);
  });
});
