/**
 * The directed-edit tool registry — the single source of truth for:
 *   1. the UI grid (GET /api/tools serves the public shape),
 *   2. the agent-callable actions (same shape, in the public OpenAPI spec),
 *   3. the prompt actually sent to the image model (`buildPrompt`, server-only).
 *
 * Each tool is a *directed edit*: a preset instruction applied to a source
 * image. Every image tool keeps the room's architecture, camera, and
 * proportions fixed and changes only the one thing named — that's what keeps
 * output grounded in the real space instead of hallucinating a new room.
 *
 * Add a capability by adding one entry here. Nothing else needs to change.
 */

export type ToolMode = "edit" | "video";

export type ToolInput = {
  name: string;
  label: string;
  type: "text" | "select";
  options?: string[];
  required?: boolean;
  placeholder?: string;
};

export type ToolDef = {
  id: string;
  label: string;
  category: "concept" | "surfaces" | "staging" | "lighting" | "polish";
  icon: string; // lucide-react icon name
  mode: ToolMode;
  description: string; // shown in the UI card AND to the agent
  inputs: ToolInput[];
  /** Resolves the model prompt from the user's input values. Server-only. */
  buildPrompt: (params: Record<string, string>) => string;
  /**
   * Optional honesty note returned with the render. Used on tools that can
   * imply geometry/dimension changes — we stay a post/ideation layer and are
   * explicit about not being a CAD/measurement tool.
   */
  disclaimer?: string;
};

const STYLES = [
  "Scandinavian",
  "Japandi",
  "Minimalist",
  "Mid-century modern",
  "Contemporary luxury",
  "Industrial",
  "Bohemian",
  "Art deco",
  "Coastal",
  "Rustic",
];

const ROOM_TYPES = [
  "Living room",
  "Bedroom",
  "Kitchen",
  "Dining room",
  "Bathroom",
  "Home office",
  "Hallway",
  "Outdoor terrace",
];

/** Prepended to every edit so the model treats the source as ground truth. */
const KEEP_ARCHITECTURE =
  "Keep the room's architecture, camera angle, perspective, windows, doors, wall positions, and proportions exactly the same. Photorealistic result, consistent lighting and shadows.";

const GEOMETRY_DISCLAIMER =
  "AI edits preserve the look, not exact measurements. Verify dimensions and any structural changes in your CAD tool before quoting build work.";

export const TOOLS: ToolDef[] = [
  {
    id: "restyle",
    label: "Restyle",
    category: "concept",
    icon: "wand-sparkles",
    mode: "edit",
    description:
      "Re-imagine the same room in a chosen design aesthetic, keeping the architecture fixed. Run it a few times for client options.",
    inputs: [
      { name: "style", label: "Style", type: "select", options: STYLES, required: true },
      { name: "notes", label: "Extra direction (optional)", type: "text", placeholder: "warmer palette, oak floors, keep the artwork" },
    ],
    buildPrompt: (p) =>
      `${KEEP_ARCHITECTURE} Redesign the interior in a ${p.style} style — furniture, materials, textiles, colour palette, and décor.${p.notes ? ` Additional direction: ${p.notes}.` : ""}`,
    disclaimer: GEOMETRY_DISCLAIMER,
  },
  {
    id: "swap_material",
    label: "Material / Finish Swap",
    category: "surfaces",
    icon: "layers",
    mode: "edit",
    description:
      "Change a single surface — floor, walls, cabinetry, countertops — to a new material or finish. The daily client A/B decision.",
    inputs: [
      { name: "target", label: "Surface", type: "select", options: ["Floor", "Walls", "Cabinetry", "Countertops", "Ceiling", "Backsplash"], required: true },
      { name: "material", label: "New material / finish", type: "text", required: true, placeholder: "warm oak herringbone" },
    ],
    buildPrompt: (p) =>
      `${KEEP_ARCHITECTURE} Change only the ${(p.target || "surface").toLowerCase()} to ${p.material}. Leave every other surface and object unchanged.`,
    disclaimer: GEOMETRY_DISCLAIMER,
  },
  {
    id: "stage_room",
    label: "Add Furniture",
    category: "staging",
    icon: "sofa",
    mode: "edit",
    description:
      "Furnish an empty or sparse room in a chosen style. Point it at your own catalogue pieces in Extra direction to stage with your collection.",
    inputs: [
      { name: "roomType", label: "Room", type: "select", options: ROOM_TYPES, required: true },
      { name: "style", label: "Style", type: "select", options: STYLES, required: true },
      { name: "notes", label: "Extra direction (optional)", type: "text", placeholder: "our Dutch Design Group lounge chair by the window" },
    ],
    buildPrompt: (p) =>
      `${KEEP_ARCHITECTURE} Stage this ${(p.roomType || "room").toLowerCase()} with realistic, well-scaled ${p.style} furniture, lighting, rugs, and décor appropriate to the space.${p.notes ? ` Include: ${p.notes}.` : ""}`,
  },
  {
    id: "declutter",
    label: "Furniture Eraser / Declutter",
    category: "staging",
    icon: "eraser",
    mode: "edit",
    description:
      "Empty the room or just remove clutter — a clean base to redesign an existing space.",
    inputs: [
      { name: "mode", label: "Mode", type: "select", options: ["Remove all furniture", "Remove clutter only"], required: true },
    ],
    buildPrompt: (p) =>
      p.mode === "Remove clutter only"
        ? `${KEEP_ARCHITECTURE} Remove clutter, personal items, and small objects. Keep the main furniture, floor, walls, and fixtures.`
        : `${KEEP_ARCHITECTURE} Remove all furniture and décor, leaving an empty room with the existing floor, walls, windows, and built-in fixtures intact.`,
  },
  {
    id: "renovate",
    label: "Renovation Before → After",
    category: "concept",
    icon: "hammer",
    mode: "edit",
    description:
      "Visualise a renovation of an existing space from a plain-language brief. For the pitch — dimensions still belong in CAD.",
    inputs: [
      { name: "instruction", label: "What to change", type: "text", required: true, placeholder: "open up the kitchen wall, add a large island, matte-black fixtures" },
    ],
    buildPrompt: (p) =>
      `${KEEP_ARCHITECTURE} Apply this renovation while keeping the room recognisably the same space: ${p.instruction}.`,
    disclaimer: GEOMETRY_DISCLAIMER,
  },
  {
    id: "relight",
    label: "Relight / Twilight",
    category: "lighting",
    icon: "sun",
    mode: "edit",
    description:
      "Change the time of day and mood — hero shots and twilight variants without a re-render.",
    inputs: [
      { name: "lighting", label: "Lighting", type: "select", options: ["Bright daylight", "Golden hour", "Twilight", "Night (interior lights on)", "Soft overcast"], required: true },
    ],
    buildPrompt: (p) =>
      `${KEEP_ARCHITECTURE} Relight the scene as ${p.lighting}. Change only lighting, shadows, and window ambience — not the furniture, materials, or layout.`,
  },
  {
    id: "enhance",
    label: "Enhance & Upscale",
    category: "polish",
    icon: "sparkles",
    mode: "edit",
    description:
      "Sharpen, clean, and boost a render to portfolio quality. Uses fal upscaling when a FAL key is set.",
    inputs: [],
    buildPrompt: () =>
      `${KEEP_ARCHITECTURE} Enhance to a crisp, professional, high-resolution architectural photograph: improve sharpness, clarity, dynamic range, and colour accuracy. Do not add or remove objects.`,
  },
  {
    id: "walkthrough",
    label: "Walkthrough Video",
    category: "polish",
    icon: "video",
    mode: "video",
    description:
      "Animate a still render into a short cinematic walkthrough clip. Renders asynchronously via OpenRouter video (takes a minute or two).",
    inputs: [
      { name: "motion", label: "Camera motion (optional)", type: "text", placeholder: "slow push-in toward the window" },
    ],
    buildPrompt: (p) =>
      `Cinematic architectural walkthrough of this interior, smooth stable camera, realistic parallax.${p.motion ? ` Motion: ${p.motion}.` : " Slow forward dolly."}`,
  },
];

export function getTool(id: string): ToolDef | undefined {
  return TOOLS.find((t) => t.id === id);
}

/** Client/agent-safe shape — omits the server-only `buildPrompt`. */
export function publicTool(t: ToolDef) {
  const { buildPrompt, ...rest } = t;
  return rest;
}
