# Chat-first control + stacking — build spec (round 2)

The owner wants **the chat to be the main way to drive the 3D room planner**, and found that **a monitor
can't be put on top of the desk**. Contract additions are already in `src/shared/types.ts`
(`ChatPlacement`, `ChatAction`, `ChatScene`, `ChatRequest`, `ChatResponse`, `PlacedItem.supportId`) and a
stub `placeOnTop(id, supportId)` in `src/state/store.ts`. Read SPEC.md and README.md for the rest of the app.

## 1. Stacking (items on top of items)

- A floor-mount item can rest on another item: `supportId` set, `position.y` = support's `position.y + dims.h`.
- **Dragging** a floor item over another floor item (dragged item's center inside the other's rotated
  footprint, and the dragged item's footprint is not much larger than the support's top — say ≤ 1.5× in
  each axis) makes it sit on top; dragging it off returns it to the floor (or onto another support).
  Pick the highest valid support under the pointer. No cycles (an item can't rest on itself or on anything
  resting on it, transitively). Hidden items are never supports.
- **Moving / rotating a support carries its stack** (dependents keep their offset relative to the support,
  rotate around it on rotation). Resizing a support's height re-seats dependents. Deleting or hiding a
  support drops dependents to whatever is below them (usually the floor). Undo restores everything as one
  step. `constrainToRoom` must not flatten stacked items back to y = 0.
- Inspector: show "On top of: <name>" with a "Put on floor" button for stacked items; for floor items, a
  "Put on…" select listing valid supports. Item list may indent stacked items under their support.
- Mount changes (floor → wall/ceiling) clear `supportId`.
- Replace the store stub `placeOnTop` with the full behavior (keep the signature). Unit-test the geometry
  (support detection, cycle prevention, carry-on-move, carry-on-rotate, delete-drops) and a scene-level E2E.

## 2. Chat (main way to interact)

### Server — `POST /api/chat` (`ChatRequest` → `ChatResponse`)
- Implemented by every provider: api (`claude.ts`), subscription (`subscription.ts`, Agent SDK, no tools,
  same cost-safety options as the existing calls), mock (`mock.ts`).
- Model `claude-opus-5-5`, structured output (zod schema mirroring `ChatAction[]` + `reply`), effort
  **low** (snappy; this is an interactive loop). Keep the system prompt stable (cache-friendly); put the scene
  JSON in the user turn.
- System prompt teaches: the coordinate system and walls (copy from SPEC/types), units (user may speak
  feet/inches; output meters), the action list with when to use each, refer to items by `id` from the scene,
  use `ref` for items created in the same response, SHAPE_PRESETS keys and typical real-world sizes
  (desk 1.2×0.75×0.6, monitor 0.6×0.4×0.2 incl. stand, nightstand 0.5×0.6×0.4, lamp, rug, bookshelf…),
  build reasonable multi-part silhouettes for common objects (monitor = thin screen box + stand + base),
  put things on surfaces with `onTop`, ask a short clarifying question (no actions) when truly ambiguous,
  use `search` when the user wants real products (and say it takes 1–3 minutes), `addCandidate` when they
  pick from the last results, never invent item ids, keep replies to 1–3 sentences.
- Validate/sanitize the model output server-side: drop actions referencing unknown ids/refs, clamp dims
  (0.02–5 m), valid hex colors, valid preset keys, placements inside the room, max ~20 actions.
- Mock provider: deterministic rule-based parser good enough for a demo and E2E: "add a desk / box / lamp /
  monitor / bed / rug …" (with optional "in the NW corner", "against the north wall", "on the desk",
  "next to the bed"), "put/move X on/onto Y", "move X to the … corner / wall", "rotate X 90", "make X red",
  "delete X", "make X 4 ft wide", "find a … lamp under $200", "add the first/second one", "undo",
  "top view". Unknown → friendly reply listing examples, no actions. Match items by name (case-insensitive,
  most recent wins).
- Tests: schema/sanitizer, mock parser cases, provider wiring with fakes (NO real calls — the test setup
  already blocks the real Agent SDK).

### Browser
- **Chat panel is the default, first tab of the left sidebar** (tabs: Chat · Room · Add · Find online), and
  should feel like the primary surface: message list (user right, assistant left), input pinned to the
  bottom (Enter sends, Shift+Enter newline), a few clickable example prompts when empty ("Add a desk
  against the west wall", "Put a monitor on the desk", "Find a Japanese hanging lamp under $200 for the
  corner", "Make the room 12 by 14 feet"), typing indicator with elapsed seconds, Cancel.
- Each assistant message lists what it did as small chips ("Added Monitor · on Desk", "Moved Bed → north
  wall") and has an **Undo this** button. A whole turn's actions apply as ONE undo step (checkpoint, then
  transient updates; or a store batch helper). Failed actions show as a muted chip with the reason.
- `src/ui/chat/`: `ChatPanel.tsx`, `chatStore.ts` (messages, pending, persisted to localStorage with the
  last ~50 messages), `executeActions.ts` (pure-ish: takes actions + store API, resolves refs, turns
  `ChatPlacement` into positions with `src/lib/geometry.ts` helpers, returns per-action results), `api`
  function `sendChat` in `src/ui/api.ts`. Build `ChatScene` from the store (+ last search results from the
  UI store).
- `search` action: run the existing product search (reuse uiStore's search flow so the Find tab shows the
  same results), show a progress bubble in chat, then a compact results message (name, price, size, style,
  link, Preview / Add buttons). "add the second one on the desk" then works via `addCandidate` + placement.
- **Photo upload from chat**: a paperclip button attaches 1–3 photos and runs the existing room build
  (with the in-page replace confirmation inside the chat), reporting the result in the chat.
- Selecting an item in 3D and typing "make this red" works (`selectedId` is in the scene).
- Show a subtle per-message note in subscription/api mode: replies use the Claude credit; mock mode says
  "demo parser".
- Keep every existing feature and test working.

## Ground rules
- **A dev server owned by the preview tool is running on ports 5173/8787 — do NOT stop or kill it, and
  don't use those ports.** For E2E use `E2E_WEB_PORT=5185 E2E_API_PORT=8785 npm run e2e` (other agents may
  use 5186/8786 or 5188/8788 — your task prompt says which pair is yours). Manual servers: use your pair
  (API_PORT env + vite --port --strictPort).
- Never make real Claude/Agent SDK calls unless your task explicitly says so.
- Don't commit. Don't add dependencies unless necessary.
