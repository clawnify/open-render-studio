import { createApp, createRoute, z } from "@clawnify/app";
import { query, get, run } from "./db.js";
import { initUploads, putUpload, getUpload } from "./uploads.js";
import { TOOLS, getTool, publicTool } from "./tools.js";
import { editImage, upscaleImage, startVideo, pollVideo } from "./image.js";

type Env = {
  Bindings: {
    DB: D1Database;
    UPLOADS: R2Bucket;
    OPENROUTER_API_KEY: string;
    FAL_API_KEY?: string;
    OPENAI_API_KEY?: string;
  };
};

const app = createApp<Env>({
  title: "Open Render Studio API",
  version: "1.0.0",
  description: "Directed-edit render studio: stage, restyle, relight, enhance, and animate room images.",
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message || String(err) }, 500);
});

// createApp bakes the DB init; uploads init is app-specific, keep it.
app.use("*", async (c, next) => {
  initUploads(c.env.UPLOADS);
  await next();
});

// ── Types ────────────────────────────────────────────────────────────

type RenderRow = {
  id: string;
  project_id: string;
  tool_id: string;
  source_image_url: string;
  params: string;
  prompt: string;
  result_image_url: string | null;
  result_video_url: string | null;
  status: string;
  provider_job_id: string | null;
  error: string | null;
  disclaimer: string | null;
  created_at: string;
};

function rid(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Core: run one directed-edit tool against a source image, persist the render,
 * and return the row. Shared by the UI route and the agent route so there's a
 * single execution path.
 */
async function runRender(
  env: Env["Bindings"],
  input: { tool_id: string; source_image_url: string; params: Record<string, string>; project_id: string },
): Promise<RenderRow> {
  const tool = getTool(input.tool_id);
  if (!tool) throw new Error(`Unknown tool: ${input.tool_id}. Call GET /api/tools for the list.`);

  const prompt = tool.buildPrompt(input.params || {});
  const id = rid("rnd");
  await run(
    "INSERT INTO renders (id, project_id, tool_id, source_image_url, params, prompt, status, disclaimer) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)",
    [id, input.project_id || "", tool.id, input.source_image_url, JSON.stringify(input.params || {}), prompt, tool.disclaimer || null],
  );

  try {
    if (tool.mode === "video") {
      // Async: kick off the job, store its id, leave the row pending. The client
      // (or agent) polls GET /api/renders/:id until it flips to done/error.
      const { jobId } = await startVideo(env, {
        imageUrl: input.source_image_url,
        prompt,
        model: input.params.model || undefined,
      });
      await run("UPDATE renders SET provider_job_id=? WHERE id=?", [jobId, id]);
    } else if (tool.id === "enhance") {
      // Prefer a true upscaler when fal is configured; otherwise fall back to a
      // model enhance pass so the tool still works on an OpenRouter-only setup.
      const { url } = env.FAL_API_KEY
        ? await upscaleImage(env, { imageUrl: input.source_image_url })
        : await editImage(env, { imageUrl: input.source_image_url, prompt });
      await run("UPDATE renders SET status='done', result_image_url=? WHERE id=?", [url, id]);
    } else {
      const { url } = await editImage(env, { imageUrl: input.source_image_url, prompt });
      await run("UPDATE renders SET status='done', result_image_url=? WHERE id=?", [url, id]);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await run("UPDATE renders SET status='error', error=? WHERE id=?", [msg, id]);
  }

  if (input.project_id) {
    await run("UPDATE projects SET updated_at=datetime('now') WHERE id=?", [input.project_id]);
  }
  const row = await get<RenderRow>("SELECT * FROM renders WHERE id=?", [id]);
  return row!;
}

/**
 * Poll-and-advance a render. For a pending video render it checks the provider
 * job and flips the row to done/error when ready. No-op for anything already
 * resolved. This is what the client/agent hits to watch an async video finish.
 */
async function refreshRender(env: Env["Bindings"], id: string): Promise<RenderRow | null> {
  const row = await get<RenderRow>("SELECT * FROM renders WHERE id=?", [id]);
  if (!row) return null;
  if (row.status !== "pending" || !row.provider_job_id) return row;
  try {
    const res = await pollVideo(env, row.provider_job_id);
    if (res.status === "completed") {
      await run("UPDATE renders SET status='done', result_video_url=? WHERE id=?", [res.url, id]);
    } else if (res.status === "failed") {
      await run("UPDATE renders SET status='error', error=? WHERE id=?", [res.error, id]);
    }
  } catch (e) {
    await run("UPDATE renders SET status='error', error=? WHERE id=?", [e instanceof Error ? e.message : String(e), id]);
  }
  return (await get<RenderRow>("SELECT * FROM renders WHERE id=?", [id]))!;
}

// ── Tools (UI) ───────────────────────────────────────────────────────

app.get("/api/tools", (c) => c.json(TOOLS.map(publicTool)));

app.get("/api/health", (c) =>
  c.json({
    openrouter: !!c.env.OPENROUTER_API_KEY,
    fal: !!c.env.FAL_API_KEY,
  }),
);

// ── Render (UI) ──────────────────────────────────────────────────────

app.post("/api/render", async (c) => {
  const body = await c.req.json<{ tool_id: string; source_image_url: string; params?: Record<string, string>; project_id?: string }>();
  if (!body.tool_id || !body.source_image_url) {
    return c.json({ error: "tool_id and source_image_url are required" }, 400);
  }
  const row = await runRender(c.env, {
    tool_id: body.tool_id,
    source_image_url: body.source_image_url,
    params: body.params || {},
    project_id: body.project_id || "",
  });
  return c.json(row);
});

// Poll a single render — advances a pending async video toward done/error.
app.get("/api/renders/:id", async (c) => {
  const row = await refreshRender(c.env, c.req.param("id"));
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(row);
});

// ── Projects ─────────────────────────────────────────────────────────

type ProjectRow = { id: string; name: string; client_name: string; notes: string; created_at: string; updated_at: string };

app.get("/api/projects", async (c) => {
  const rows = await query<ProjectRow>("SELECT * FROM projects ORDER BY updated_at DESC");
  return c.json(rows);
});

app.post("/api/projects", async (c) => {
  const body = await c.req.json<{ name?: string; client_name?: string; notes?: string }>().catch(() => ({}));
  const id = rid("prj");
  await run("INSERT INTO projects (id, name, client_name, notes) VALUES (?, ?, ?, ?)", [
    id,
    body.name || "Untitled Project",
    body.client_name || "",
    body.notes || "",
  ]);
  const row = await get<ProjectRow>("SELECT * FROM projects WHERE id=?", [id]);
  return c.json(row);
});

app.get("/api/projects/:id", async (c) => {
  const row = await get<ProjectRow>("SELECT * FROM projects WHERE id=?", [c.req.param("id")]);
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(row);
});

app.put("/api/projects/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ name?: string; client_name?: string; notes?: string }>();
  await run("UPDATE projects SET name=COALESCE(?,name), client_name=COALESCE(?,client_name), notes=COALESCE(?,notes), updated_at=datetime('now') WHERE id=?", [
    body.name ?? null,
    body.client_name ?? null,
    body.notes ?? null,
    id,
  ]);
  const row = await get<ProjectRow>("SELECT * FROM projects WHERE id=?", [id]);
  return c.json(row);
});

app.delete("/api/projects/:id", async (c) => {
  const id = c.req.param("id");
  await run("DELETE FROM renders WHERE project_id=?", [id]);
  await run("DELETE FROM projects WHERE id=?", [id]);
  return c.json({ ok: true });
});

app.get("/api/projects/:id/renders", async (c) => {
  const rows = await query<RenderRow>("SELECT * FROM renders WHERE project_id=? ORDER BY created_at DESC", [c.req.param("id")]);
  return c.json(rows);
});

// ── Assets (the studio's own library) ────────────────────────────────

type AssetRow = { id: string; kind: string; name: string; description: string; image_url: string | null; created_at: string };

app.get("/api/assets", async (c) => {
  const kind = c.req.query("kind");
  const rows = kind
    ? await query<AssetRow>("SELECT * FROM assets WHERE kind=? ORDER BY created_at DESC", [kind])
    : await query<AssetRow>("SELECT * FROM assets ORDER BY created_at DESC");
  return c.json(rows);
});

app.post("/api/assets", async (c) => {
  const body = await c.req.json<{ kind?: string; name: string; description?: string; image_url?: string }>();
  if (!body.name) return c.json({ error: "name is required" }, 400);
  const id = rid("ast");
  await run("INSERT INTO assets (id, kind, name, description, image_url) VALUES (?, ?, ?, ?, ?)", [
    id,
    body.kind || "furniture",
    body.name,
    body.description || "",
    body.image_url || null,
  ]);
  const row = await get<AssetRow>("SELECT * FROM assets WHERE id=?", [id]);
  return c.json(row);
});

// ── Uploads ──────────────────────────────────────────────────────────

app.post("/api/uploads", async (c) => {
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.json({ error: "file is required" }, 400);
  const ext = (file.name.split(".").pop() || "png").replace(/[^a-z0-9]/gi, "").toLowerCase() || "png";
  const filename = `up_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const url = await putUpload(filename, await file.arrayBuffer(), file.type || "image/png");
  return c.json({ url });
});

app.get("/api/uploads/:filename", async (c) => {
  const result = await getUpload(c.req.param("filename"));
  if (!result) return c.json({ error: "Not found" }, 404);
  return new Response(result.data, { headers: { "Content-Type": result.contentType, "Cache-Control": "public, max-age=31536000, immutable" } });
});

// ── Agent-facing public API (in the OpenAPI spec) ────────────────────

const ToolInputSchema = z.object({
  name: z.string(),
  label: z.string(),
  type: z.enum(["text", "select"]),
  options: z.array(z.string()).optional(),
  required: z.boolean().optional(),
  placeholder: z.string().optional(),
});
const ToolSchema = z.object({
  id: z.string(),
  label: z.string(),
  category: z.string(),
  icon: z.string(),
  mode: z.enum(["edit", "video"]),
  description: z.string(),
  inputs: z.array(ToolInputSchema),
  disclaimer: z.string().optional(),
});

const listToolsRoute = createRoute({
  method: "get",
  path: "/api/v1/tools",
  summary: "List the directed-edit tools an agent can run on a room image.",
  responses: { 200: { content: { "application/json": { schema: z.array(ToolSchema) } }, description: "OK" } },
});
app.openapi(listToolsRoute, (c) => c.json(TOOLS.map(publicTool), 200));

const RenderResultSchema = z.object({
  id: z.string(),
  tool_id: z.string(),
  status: z.string(),
  result_image_url: z.string().nullable(),
  result_video_url: z.string().nullable(),
  prompt: z.string(),
  disclaimer: z.string().nullable(),
  error: z.string().nullable(),
});

const renderRoute = createRoute({
  method: "post",
  path: "/api/v1/render",
  summary: "Run a directed edit (stage, restyle, swap material, relight, enhance, walkthrough) on a room image.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            tool_id: z.string().openapi({ example: "restyle" }),
            source_image_url: z.string().openapi({ description: "An /api/uploads/* URL or a public image URL." }),
            params: z.record(z.string()).optional().openapi({ example: { style: "Japandi" } }),
            project_id: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { content: { "application/json": { schema: RenderResultSchema } }, description: "Render result" },
    400: { content: { "application/json": { schema: z.object({ error: z.string() }) } }, description: "Bad request" },
  },
});
app.openapi(renderRoute, async (c) => {
  const body = c.req.valid("json");
  if (!getTool(body.tool_id)) return c.json({ error: `Unknown tool: ${body.tool_id}` }, 400);
  const row = await runRender(c.env, {
    tool_id: body.tool_id,
    source_image_url: body.source_image_url,
    params: body.params || {},
    project_id: body.project_id || "",
  });
  return c.json(
    {
      id: row.id,
      tool_id: row.tool_id,
      status: row.status,
      result_image_url: row.result_image_url,
      result_video_url: row.result_video_url,
      prompt: row.prompt,
      disclaimer: row.disclaimer,
      error: row.error,
    },
    200,
  );
});

const getRenderRoute = createRoute({
  method: "get",
  path: "/api/v1/renders/{id}",
  summary: "Poll a render. Image edits finish immediately; a video render stays 'pending' until the async job completes — poll this until status is 'done' or 'error'.",
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: { content: { "application/json": { schema: RenderResultSchema } }, description: "Render state" },
    404: { content: { "application/json": { schema: z.object({ error: z.string() }) } }, description: "Not found" },
  },
});
app.openapi(getRenderRoute, async (c) => {
  const row = await refreshRender(c.env, c.req.valid("param").id);
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json(
    {
      id: row.id,
      tool_id: row.tool_id,
      status: row.status,
      result_image_url: row.result_image_url,
      result_video_url: row.result_video_url,
      prompt: row.prompt,
      disclaimer: row.disclaimer,
      error: row.error,
    },
    200,
  );
});

export default app;
