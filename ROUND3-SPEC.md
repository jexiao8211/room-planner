# Round 3 — stable app with auto-update, room design versions, under/over stacking, ceiling hang

Owner feedback this round (verbatim intent):
- "Can you make it so I don't have to manually reload the page?" — the page broke because agents edited
  files while the owner's tab ran the hot-reloading dev server.
- "Can we have versioning?" → **room design versions** (not app versions).
- "I kinda want to be able to just drag it over the desk and it can go on top, or if I drag it below, it can
  still go below the desk."
- "For the pendant lamp, can I make it snap to the ceiling?" (Their pendant product showed Mount = Floor.)
- Chat reply chips said ok AND "that spot is taken: overlaps Monitor" when the desk was moved before the
  monitor was put on it.

## 1. Stable app + automatic updates (no manual reloads)

- ALREADY DONE (by the orchestrator): the owner's app is a **release instance**. `npm start` =
  `scripts/dev.mjs preview` → `vite preview --outDir release` on 5173 + `tsx server/index.ts` (no watch,
  stdin detached) on 8787, started by the preview tool. `npm run deploy:local` = `npm run build` +
  `scripts/deploy-local.mjs`, which copies dist/ → release/ and writes `release/version.json`
  `{ buildId, builtAt }`. Agents' `npm run build` only writes dist/, so the owner never sees half-done work.
  **Never run deploy:local yourself** — the orchestrator deploys after the round is verified.
- **Build id**: the client bakes its build id in at build time (vite `define`, e.g. `__BUILD_ID__`), and
  deploy-local.mjs must write the SAME id into release/version.json (e.g. have the build write
  dist/version.json with the id it baked, and deploy-local copy it instead of inventing a new one). The
  page polls `GET /version.json` (served by vite preview from release/, no API involvement; add a cache-busting
  query) — in dev (`npm run dev`) the file is absent → treat as "dev", never reload.
- **Auto-update in the client** (`src/ui/autoUpdate.ts` + small UI): poll `/version.json` every 20 s and on
  window focus/visibility; tolerate the server being briefly down during a redeploy. When the published
  buildId differs from the page's, reload automatically **when safe**: no chat/search/photo build in
  flight, no drag in progress, the chat input is empty (or its draft is persisted and restored), and no
  text field focused. Otherwise show a slim bar "Updated version ready — applying when you're done ·
  Update now". All state that matters is already persisted (plan, chat, UI store); verify a reload restores
  the same view (tab, selection may reset, camera preset).
- If a chat/search request fails because the API restarted mid-request, show a clear "The app was updated
  while this was running — please resend" with a one-click Resend.
- Fix the React Fast Refresh invalidations (`CHAT_EXAMPLES` in ChatPanel.tsx, `fitNotes` in FindTab.tsx):
  move non-component exports into their own modules.
- Verify on your own ports: run a preview of a built dist (vite preview --outDir <tmp copy> --port <yours>),
  open the page, then replace the files with a newer build + version.json and confirm the open page reloads
  itself only when safe, and shows the bar when not.

- Note: the release API runs the working-tree server/ source and only reloads it when restarted; the
  orchestrator restarts it on deploy. Keep server changes backward compatible with the previous client
  (an old open page may call the new API for a few seconds before it reloads).

## 0. Shared contract for this round

Already written by the orchestrator in `src/shared/types.ts` (additive): `PlacedItem.supportSurfaceY`,
`PlacedItem.light`, `LightSettings`, `Opening.covering`, `Room.lighting`, `LightingMode`, `DesignVersion`,
new `ChatPlacement` kinds/fields (`under`, `onTop.level`), new `ChatAction`s (`saveVersion`,
`restoreVersion`, `setLighting`, `setLight`, `setWindow`, `hang`) and `ChatScene.versions`/`lighting`.
Implement against these; if one is unworkable, change it additively and say so in your report.

## 2. Room design versions

- Additive types: `DesignVersion { id, name, createdAt, auto: boolean, reason?: string, room, items,
  thumbnail?: string /* small JPEG data URL */ }`.
- Store (separate persisted store `src/state/versions.ts`, key `room-planner-versions-v1`):
  `saveVersion(name?)`, `restoreVersion(id)` (first auto-saves the current design as "Before restoring
  <name>", then replaceRoom — undoable), `renameVersion`, `deleteVersion`, `duplicateVersion`.
  Auto snapshots (auto: true) before: building a room from photos, a chat turn with ≥ 3 changes, reset,
  import, restoring a version; plus at most one every 10 minutes while the design keeps changing. Keep the
  newest 30 auto snapshots; named versions are kept until deleted. Skip an auto snapshot identical to the
  newest one. Guard localStorage quota (drop oldest auto snapshots / thumbnails first; never crash).
- Thumbnail: capture the 3D canvas (preserveDrawingBuffer or render-on-demand) scaled to ~200 px JPEG.
- UI: toolbar "Versions" button → panel/drawer listing versions (thumbnail, name, time ago, item count,
  "auto" badge), Save current (name input, default "Version N"), Restore, Rename, Delete. Current design is
  shown at the top as "Current (unsaved changes)" when it differs from the newest version.
- Chat: additive actions `{ type: "saveVersion"; name?: string }` and `{ type: "restoreVersion"; versionId:
  string }`; ChatScene gets `versions: {id,name,createdAt,auto}[]` (newest 20). The model can then handle
  "save this as option A", "go back to option A", "show me the version from before the chat changes".
  Update server zod schema, sanitizer, prompt, mock parser.
- Export: "Export all versions" option alongside the current-plan export; import accepts both.

## 3. Stacking: over AND under

- Dragging a floor item over a support: if the cursor ray hits the support's top surface (its top plane
  within its rotated footprint) → on top. If the ray reaches the floor inside the footprint without the
  top-surface hit (i.e. you're pointing under it, between the legs) AND the item fits under the support's
  clearance → on the floor under it. Otherwise (doesn't fit under) → on top as today.
- Clearance of a support = the lowest bottom of the parts that cover its center region (from `parts`
  fractions × dims); a solid box (bed, dresser) has clearance 0. The Desk preset has ~0.94 × h.
- Items under a support move with it (treat as dependents with `supportId` + a flag, or recompute) — at
  minimum they must not get pulled on top when the desk moves.
- Inspector "Put on…" also offers "Under <desk>" when it fits. Chat placement gains
  `{ kind: "under"; targetId }` (additive), handled by executor, sanitizer, prompt, mock parser.

## 4. Ceiling items

- Ceiling-mount items never participate in floor stacking: dragging moves them in x/z at the ceiling;
  `placeOnTop` / stacking must not silently turn a ceiling item into a floor item (find and fix how the
  owner's pendant ended up Mount = Floor; add a regression test).
- Inspector: "Hang from ceiling" button for any item (sets mount ceiling, fits a cord drop for hanging
  products / lamp-like items using the existing fitHangingItem), and an adjustable **drop** (distance from
  ceiling to the item's bottom) for ceiling items.
- Chat understands "hang it from the ceiling", "lower the lamp by 6 inches".

## 5. Chat executor correctness

- Apply a turn's actions in dependency order so stacks don't collide with themselves (moving a support
  must ignore its own dependents and items that the same turn will put on it).
- A chip is either ok or failed — never ok with an error string. Use a third state "adjusted" (warning
  style) when the action happened but differently than asked, with the reason.

## 6. Lighting (owner: "add lighting modes, with light sources from the light elements, and close + open
## window with lighting options")

- **Lighting modes** (toolbar segmented control + chat): **Day** (bright neutral ambient + sunlight through
  open windows), **Evening** (warm low sun, dimmer ambient, lamps noticeably contributing), **Night** (very
  dim cool ambient, only lamps light the room). Persisted in the plan (additive `Room.lighting?: "day" |
  "evening" | "night"`, default day). Switch smoothly (short tween) — keep it cheap.
- **Lights from light items**: additive `PlacedItem.light?: { on: boolean; color: string /* hex, warm
  ~#ffd8a8 default */; intensity: number /* 0..1 UI scale */ }`. Lamp-like items get a light automatically
  (presets: Hanging lamp; products/shapes whose name or category says lamp, light, lantern, pendant, sconce,
  chandelier; chat-created lamps). Render a point light at the shade (pendant: inside the shade part; floor/
  desk lamp: top part) plus an emissive glow on the shade part when on. Limit real-time shadow casting to the
  2–3 nearest/brightest lights (or none if perf suffers); keep frame rate smooth with ~8 lights.
  Inspector: Light on/off toggle, brightness slider, warm↔cool color. Chat: "turn off the desk lamp", "make
  the pendant warmer/brighter", "add a floor lamp by the bed".
- **Windows open/closed**: additive `Opening.covering?: "open" | "closed"` for windows (default open).
  Closed → render a curtain/blind panel over the window and block its daylight; Open → glass + daylight.
  In Day/Evening modes each open window casts a soft sunlight beam into the room (spot/directional light
  aimed through the window, color by mode; evening = warm/orange, lower angle). At Night windows show a dark
  blue sky tint and contribute ~nothing. Toggle per window: click the window in 3D (small popover) or the
  Room tab's openings list, and chat ("close the blinds", "open the window by the desk").
- Make sure materials respond to light (MeshStandardMaterial with sensible roughness); keep walls readable
  in Night mode (a faint ambient floor so the room isn't pitch black) and keep the cutaway behavior working.
- E2E: switch modes, toggle a lamp, close/open a window; screenshot each mode (docs/screenshots/
  lighting-day.png / -evening.png / -night.png) and LOOK at them — they must look clearly different and good.

## 7. Multi-level surfaces (owner: "add a cat element so I can put it on the cat tower")

- Cat and Cat tower presets now exist (src/lib/presets.ts, keys `cat`, `cattower`). Today an item can only
  sit on a support's bounding-box TOP (the tower's top perch at 1.5 m).
- Make supports part-aware: every part's upward-facing top (box/cylinder top faces; fractions × dims) is a
  candidate surface. Dragging onto the tower picks the surface under the cursor ray (top perch, middle
  platform at ~0.9 m, condo roof, base) — same "highest surface the ray hits within its footprint" rule as
  section 3's over/under logic, which this generalizes (desk top vs floor under the desk). Store the chosen
  height (e.g. `supportSurfaceY` or a surface index) so it survives moves/rotations of the support.
- Inspector "Put on…" lists surfaces for multi-level supports ("Cat tower — top perch / middle platform").
  Chat: "put the cat on the middle level of the cat tower"; mock parser handles it.
