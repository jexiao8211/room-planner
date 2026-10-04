# Room Planner — build spec

A small, local, single-user web app built overnight. Three things:

1. **Room from photos.** Upload 1–3 photos of a room. Claude (vision) estimates the room's dimensions,
   doors/windows, and existing furniture as simple shapes. Optionally type one known measurement
   (e.g. "ceiling height = 8 ft") and everything is scaled to match. Everything stays editable.
   A manual path (type width/depth/height) also exists, and the app opens on a default 12'×11' bedroom.
2. **Shape placer in 3D.** Orbit around the room in the browser. Add primitives (box, cylinder, sphere,
   cone) and quick furniture silhouettes. Select, drag on the floor, rotate, resize, recolor, snap to wall
   or corner, duplicate, delete, undo/redo. Floor / wall / ceiling mounting (a hanging lamp hangs from
   the ceiling). No textures; flat colors are fine.
3. **Find real products online.** Describe what you want ("hanging lamp for the corner, Japanese, under
   $200"). Claude searches the web and returns 4–6 real products with traits — size, colors, style tags,
   origin, materials, price, retailer link, image — plus a primitive approximation of the shape. Preview a
   candidate as a translucent ghost in the room, then add it at true scale.

Runs locally: `npm run dev` → web on http://localhost:5173, API on http://localhost:8787 (Vite proxies `/api`).
With `MOCK_AI=1` (or `AI_PROVIDER=mock`) the API serves realistic **mock** data so the whole app still works
end to end; the UI shows a "Demo data" banner.

**Providers** (added after the initial build): `AI_PROVIDER` = `auto` (default) | `api` | `subscription` | `mock`.
`auto`: `MOCK_AI` on → mock; `ANTHROPIC_API_KEY` set → api; else **subscription**, the owner's Claude Pro/Max plan
via `@anthropic-ai/claude-agent-sdk` (Claude Code login, no key; `server/subscription.ts`). Subscription calls run
with no setting sources, no MCP servers (`strictMcpConfig`, `ENABLE_CLAUDEAI_MCP_SERVERS=false`), no persisted
session, a custom system prompt, an empty temp cwd, per-call `maxBudgetUsd` caps, and a child env built
from an allowlist of OS variables (no `ANTHROPIC_*` / `CLAUDE_*` except `CLAUDE_CONFIG_DIR`; `CLAUDE_CODE_ENTRYPOINT=sdk-ts`
set explicitly). Research sources are search hits and 2xx WebFetch URLs from the tools' structured output only. Both live providers share `server/postprocess.ts`. `HealthResponse.provider` (additive) names
the active provider; `mode` stays `live` | `mock`.

## Stack

TypeScript everywhere. React 19 + Vite 8, three.js via @react-three/fiber 9 + @react-three/drei 10,
zustand 5 for state. Server: Express 5 run with `tsx`, `@anthropic-ai/sdk`, zod 4. Tests: vitest
(unit), Playwright (E2E). TypeScript 7 (`tsc` is the native compiler) — `npm run typecheck` must pass.

## Ground rules for all builders

- **The contract is `src/shared/types.ts`.** Do not change it without strong reason; if you must, keep
  changes additive and mention them in your final report.
- **State lives in `src/state/store.ts`** (`usePlanner`). UI and scene read/write state only through it.
  Additive store actions are allowed if you need them; don't change existing signatures.
- Geometry helpers: `src/lib/geometry.ts`. Units/formatting: `src/lib/units.ts`. Presets + ids:
  `src/lib/presets.ts`. All internal lengths are **meters**; display defaults to imperial (ft/in).
- Stay inside the directories you own (below). Don't run `npm install` for new packages unless truly
  needed; if you do, say so in your report.
- Keep code plain and readable; comment only where intent isn't obvious.
- Windows machine; the Bash tool is Git Bash.

## Ownership

| Area | Owner dirs | Notes |
|---|---|---|
| API server | `server/` | Express app, Claude calls, mock fixtures, server tests |
| 3D scene | `src/scene/` | `<Scene />` component and everything inside the Canvas |
| UI shell | `src/ui/`, `src/App.tsx`, `src/main.tsx`, `src/styles.css` | Panels, layout, API client |
| Shared | `src/shared/`, `src/state/`, `src/lib/` | Pre-written; additive edits only |

## API (server/)

- `GET /api/health` → `HealthResponse` (`mode: "mock"` for the mock provider, else `"live"`; `provider` names it).
- `POST /api/rooms/from-photos` body `RoomFromPhotosRequest` (JSON, base64 images, client downsizes to
  ≤1568px long edge, JPEG) → `RoomFromPhotosResponse`. Body limit ~25 MB.
- `POST /api/products/search` body `ProductSearchRequest` → `ProductSearchResponse`.
- Errors: HTTP 4xx/5xx with `{ error: string }`. Validate request bodies with zod.

Claude usage (verified against the bundled claude-api skill docs, SDK 0.131):
- Model `claude-opus-5-5`. Thinking is always on for this model — do **not** send `thinking: {type:"disabled"}`
  or `budget_tokens`; control depth with `output_config: { effort: "low" | "medium" | "high" }`.
- Structured output: `client.messages.parse({ ..., output_config: { format: zodOutputFormat(Schema) } })`
  from `@anthropic-ai/sdk/helpers/zod`; read `response.parsed_output` (may be null → error).
- Vision: content blocks `{ type: "image", source: { type: "base64", media_type, data } }` before the text.
- Web search: server tool `{ type: "web_search_20260209", name: "web_search", max_uses: N }`. Errors come
  back as HTTP 200 with an error object inside `web_search_tool_result` — don't assume success.
  A long turn can end with `stop_reason: "pause_turn"`: resume by appending the assistant content and
  calling again (cap the loop). Check `stop_reason === "refusal"` before reading content.
- Product search = **two steps**: (1) research call with web_search producing a text report with URLs and
  facts; (2) `messages.parse` with a zod schema turning that report into `ProductCandidate[]`
  (including `parts` primitives, `dimsSource`, colors with hex). Don't combine web search and structured
  output in one call.
- Room-from-photos = one `messages.parse` call with images + zod schema. If `knownMeasurement` is given,
  instruct the model to use it, and additionally rescale the result server-side if the model's own
  value for that measurement differs.
- Sanitize model output server-side: clamp dims to sane ranges (items 0.02–5 m, room 1.5–15 m wide,
  1.8–6 m high), ensure ids are unique, hex colors valid, parts non-empty, openings within walls.
- Never log or return the API key. `.env` via `dotenv`.

## Scene (src/scene/)

- Export `Scene` (default or named) rendering a full-size R3F `<Canvas>` with shadows off-by-default ok.
- Room: floor (floorColor) with a subtle grid (1 ft or 0.5 m), 4 walls (wallColor) with door/window
  openings cut out (build each wall from rectangles around the openings — no CSG lib). Ceiling hidden.
  **Cutaway**: walls between the camera and the room center fade/hide so you can always see inside.
- Items: render each `PlacedItem`'s `parts` (fractions of bbox → scaled unit geometries) at
  `position` (bottom-center) and `rotationY`. Selected item gets an outline/bbox helper.
  Hidden items not rendered. Ghost preview of `preview` candidate (translucent, near room center or a
  sensible mount position) when set.
- Interaction: click item to select, click empty floor to deselect. Drag a selected item across the floor
  plane (floor/ceiling mounts move in x/z; wall mounts slide along their wall and up/down). Use
  `checkpoint()` at drag start + `updateItem(..., {transient:true})` during drag. Disable OrbitControls
  while dragging. Rotation via keyboard (R / Shift+R = ±15°) and the inspector.
- Camera: OrbitControls (damping), sensible initial isometric-ish view; expose camera presets
  (top-down, corner/iso, eye-level from door) via a small store or event so the UI can trigger them.
- Dimension labels on hover/selected (drei `Html` is fine), in the user's units.
- Keyboard: Delete/Backspace remove selected, Ctrl+Z / Ctrl+Shift+Z (or Ctrl+Y) undo/redo, Ctrl+D
  duplicate, Esc deselect. (Ignore when focus is in an input.)

## UI (src/ui/, App.tsx)

Layout: 3D view fills the main area; left sidebar with tabs **Room**, **Add**, **Find online**; right
inspector panel when something is selected. Clean, modern, light theme, readable at 1280×800 and usable
down to ~1024 wide.

- **Room tab**: photo upload (drag & drop or picker, 1–3 images, thumbnails), optional "one thing I know
  the size of" (label + length parsed with `parseLength`), notes, "Build room from photos" button with a
  progress state (the call can take 30–90 s). Then manual fields: name, width, depth, height, wall
  color, floor color, openings list (add/edit/remove door/window). Units toggle (imperial/metric).
  Shows `notes` returned by the API.
- **Add tab**: `SHAPE_PRESETS` palette → `addItem`. Item list of everything in the room (select, hide,
  delete), grouped by existing / added / products.
- **Find online tab**: query box + optional mount, style, max price. Results as cards: image (if any),
  name, retailer, price, dims (with "est." badge if estimated), color swatches, style chips, origin,
  materials, link (opens new tab). Buttons: **Preview** (sets ghost) and **Add to room**. Loading state
  with elapsed seconds; errors shown inline.
- **Inspector**: name, dims (w/d/h inputs in current units), position x/z(/y for wall), rotation slider,
  color, mount select, snap to wall / snap to corner, duplicate, delete, lock. For products: link, price,
  traits.
- Toolbar: undo/redo, camera presets, export/import JSON (file download/upload), reset, units toggle,
  mock-mode banner from `/api/health`.
- API client in `src/ui/api.ts` with typed functions and image downscaling helper.

## Done means

`npm run typecheck`, `npm test`, `npm run build` pass; `npm run e2e` passes against mock mode; the app
works in a real browser: build room from a photo (mock), add shapes, drag, search products (mock), preview
and add one, undo, export/import, reload persists.
