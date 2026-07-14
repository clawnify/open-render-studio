export type ToolInput = {
  name: string;
  label: string;
  type: "text" | "select";
  options?: string[];
  required?: boolean;
  placeholder?: string;
};

export type Tool = {
  id: string;
  label: string;
  category: string;
  icon: string;
  mode: "edit" | "video";
  description: string;
  inputs: ToolInput[];
  disclaimer?: string;
};

export type Render = {
  id: string;
  tool_id: string;
  source_image_url: string;
  params: string;
  prompt: string;
  result_image_url: string | null;
  result_video_url: string | null;
  status: string;
  error: string | null;
  disclaimer: string | null;
  created_at: string;
};

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}

export const api = {
  listTools: () => fetch("/api/tools").then(json<Tool[]>),
  health: () => fetch("/api/health").then(json<{ openrouter: boolean; fal: boolean }>),
  async upload(file: File): Promise<string> {
    const fd = new FormData();
    fd.append("file", file);
    const { url } = await json<{ url: string }>(await fetch("/api/uploads", { method: "POST", body: fd }));
    return url;
  },
  render: (body: { tool_id: string; source_image_url: string; params: Record<string, string>; project_id?: string }) =>
    fetch("/api/render", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(json<Render>),
};
