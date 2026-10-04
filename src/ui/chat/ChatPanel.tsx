// The chat: the main way to drive the planner. Messages on top, the composer pinned to the bottom.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ProductCandidate } from "../../shared/types";
import { usePlanner } from "../../state/store";
import { formatDims, formatLength } from "../../lib/units";
import { httpUrl } from "../../lib/urls";
import { Badge, Spinner, formatPrice, useNow } from "../controls";
import { ProductImage } from "../ProductBits";
import { Icon } from "../icons";
import { MAX_PHOTOS, useUI } from "../uiStore";
import { useChat, type ChatMessage, type ChatVia } from "./chatStore";
import { chipStatus, redoTurn, turnStatus, undoTurn, type ActionResult, type TurnStatus, type TurnStep } from "./executeActions";
import { SCENE_LIMITS, resultsHint } from "./buildScene";
import { CHAT_EXAMPLES } from "./chatExamples";
import { useChatDraft } from "./chatDraft";

const VIA_NOTE: Record<ChatVia, string> = {
  mock: "demo parser",
  subscription: "Claude · uses your plan's Agent SDK credit",
  api: "Claude · API key",
  live: "Claude",
};

export function ChatPanel() {
  const messages = useChat((s) => s.messages);
  const pending = useChat((s) => s.pending);
  const { send, loadProvider, clear } = useChat.getState();
  // Persisted on every keystroke: an automatic update (or any reload) brings the text back.
  const draft = useChatDraft((s) => s.text);
  const setDraft = useChatDraft.getState().setText;
  const [attachMsg, setAttachMsg] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => loadProvider(), [loadProvider]);
  // The chat is the main way in: ready to type as soon as the app opens.
  useEffect(() => {
    const el = inputRef.current;
    el?.focus({ preventScroll: true });
    // A draft restored after a reload: continue typing at its end.
    el?.setSelectionRange(el.value.length, el.value.length);
  }, []);

  // Keep the newest message in view (also while a search / build bubble grows).
  const last = messages[messages.length - 1];
  const lastKey = `${messages.length}:${last?.search?.status ?? ""}:${last?.build?.status ?? ""}:${pending ? 1 : 0}`;
  // Whether the view is "following" the conversation: true until the user scrolls away from where we put it.
  const followRef = useRef(true);
  const autoTopRef = useRef<number | null>(null);
  const pin = () => {
    const el = logRef.current;
    if (!el || !followRef.current) return;
    // A message taller than the view (search results) shows from its top; otherwise stick to the bottom.
    const rows = el.querySelectorAll<HTMLElement>(".chat-row");
    const lastRow = rows[rows.length - 1];
    el.scrollTop = lastRow && lastRow.offsetHeight > el.clientHeight - 24 ? lastRow.offsetTop - 8 : el.scrollHeight;
    autoTopRef.current = el.scrollTop;
  };
  useLayoutEffect(() => {
    followRef.current = true; // a new message always brings the view back
    pin();
  }, [lastKey]);
  // Product thumbnails load after the first layout (e.g. right after a reload) and push the newest message down.
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const onLoad = () => pin();
    const onScroll = () => {
      const auto = autoTopRef.current;
      if (auto != null && Math.abs(el.scrollTop - auto) < 2) return;
      autoTopRef.current = null;
      followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    };
    el.addEventListener("load", onLoad, true); // load doesn't bubble: capture it from the images
    el.addEventListener("scroll", onScroll, { passive: true });
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => pin()) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener("load", onLoad, true);
      el.removeEventListener("scroll", onScroll);
      ro?.disconnect();
    };
  }, []);

  const submit = (text = draft) => {
    if (!text.trim() || pending) return;
    void send(text);
    setDraft("");
    setAttachMsg(null);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="chat" data-testid="chat-panel">
      <div className="chat-log" ref={logRef} role="log" aria-live="polite" aria-label="Conversation">
        {messages.length === 0 ? (
          <ChatEmpty onPick={(t) => submit(t)} disabled={!!pending} />
        ) : (
          <>
            <div className="chat-log-head">
              <button type="button" className="btn btn-quiet btn-sm" data-testid="chat-clear" onClick={clear} disabled={!!pending}>
                Clear chat
              </button>
            </div>
            {messages.map((m) => (
              <MessageView key={m.id} m={m} />
            ))}
          </>
        )}
        {pending ? <Typing startedAt={pending.startedAt} /> : null}
      </div>

      <form
        className="chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {attachMsg ? <div className="inline-msg warn small">{attachMsg}</div> : null}
        <div className="chat-input-wrap">
          <textarea
            ref={inputRef}
            className="chat-input"
            data-testid="chat-input"
            rows={2}
            aria-label="Message"
            placeholder="Tell me what to change, e.g. “put a lamp next to the bed”"
            value={draft}
            maxLength={SCENE_LIMITS.message}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="chat-input-row">
            <label className="btn btn-icon btn-quiet chat-attach-btn" title={`Build the room from 1–${MAX_PHOTOS} photos`}>
              <Icon.paperclip />
              <span className="visually-hidden">Attach room photos</span>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                className="visually-hidden"
                data-testid="chat-attach"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  if (files.length) setAttachMsg(useChat.getState().attachPhotos(files));
                  if (fileRef.current) fileRef.current.value = "";
                }}
              />
            </label>
            <span className="chat-hint" title="Enter sends · Shift+Enter starts a new line">
              Shift+Enter: new line
            </span>
            <button type="submit" className="btn btn-primary btn-sm chat-send" data-testid="chat-send" disabled={!draft.trim() || !!pending} aria-label="Send">
              <Icon.send />
              Send
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

function ChatEmpty({ onPick, disabled }: { onPick: (text: string) => void; disabled: boolean }) {
  return (
    <div className="chat-empty">
      <div className="chat-empty-icon">
        <Icon.sparkle />
      </div>
      <h2>What should we change?</h2>
      <p className="muted small">
        Describe it in plain words: add furniture, move things around, put a monitor on the desk, resize the room or find real
        products. Use the paperclip to build the room from photos.
      </p>
      <ul className="chat-examples">
        {CHAT_EXAMPLES.map((t) => (
          <li key={t}>
            <button type="button" className="chat-example" data-testid="chat-example" disabled={disabled} onClick={() => onPick(t)}>
              {t}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Typing({ startedAt }: { startedAt: number }) {
  const now = useNow(true);
  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));
  return (
    <div className="chat-row assistant" data-testid="chat-typing" role="status">
      <div className="chat-bubble chat-typing">
        <span className="typing-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="muted small">Thinking… {elapsed}s</span>
        <button type="button" className="btn btn-secondary btn-sm" data-testid="chat-cancel" onClick={() => useChat.getState().cancel()}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function MessageView({ m }: { m: ChatMessage }) {
  if (m.role === "user") {
    return (
      <div className="chat-row user" data-testid="chat-message" data-role="user">
        <div className="chat-bubble">
          {m.kind === "photos" ? (
            <div className="chat-photos">
              {m.thumbs?.length ? (
                <div className="chat-thumbs">
                  {m.thumbs.map((u, i) => (
                    <img key={u} src={u} alt={`Photo ${i + 1}`} />
                  ))}
                </div>
              ) : null}
              <span>
                <Icon.paperclip /> {m.photos ?? 0} photo{m.photos === 1 ? "" : "s"} of the room
              </span>
            </div>
          ) : (
            m.text
          )}
        </div>
      </div>
    );
  }
  return (
    <div className={`chat-row assistant kind-${m.kind}`} data-testid="chat-message" data-role="assistant" data-kind={m.kind}>
      {m.kind === "search" && m.search ? (
        <SearchBubble m={m} />
      ) : m.kind === "build" && m.build ? (
        <BuildBubble m={m} />
      ) : (
        <div className={`chat-bubble${m.kind === "error" ? " chat-error" : m.kind === "note" ? " chat-note" : ""}`} role={m.kind === "error" ? "alert" : undefined}>
          <div className="chat-text">{m.text}</div>
          {m.results?.length ? <ActionChips results={m.results} /> : null}
          {m.step ? <UndoControls step={m.step} /> : null}
          {m.kind === "error" && m.retryText ? (
            <button type="button" className="btn btn-secondary btn-sm" data-testid="chat-retry" onClick={() => void useChat.getState().send(m.retryText!)}>
              {m.interrupted ? "Resend" : "Retry"}
            </button>
          ) : null}
          {m.via ? <div className="chat-via">{VIA_NOTE[m.via]}</div> : null}
        </div>
      )}
    </div>
  );
}

function ActionChips({ results }: { results: ActionResult[] }) {
  return (
    <ul className="chat-chips" aria-label="What changed">
      {results.map((r, i) => {
        // ok, adjusted (done differently than asked: warning style + why) or failed (muted + why); never ok + error.
        const status = chipStatus(r);
        const reason = status === "failed" ? r.error : status === "adjusted" ? (r.note ?? r.error) : undefined;
        return (
          <li
            key={i}
            className={`chat-chip${status === "failed" ? " failed" : status === "adjusted" ? " adjusted" : ""}`}
            data-testid="chat-action-chip"
            data-ok={status === "failed" ? "false" : "true"}
            data-status={status}
            title={reason ? `${r.label}: ${reason}` : r.label}
          >
            {r.swatch ? <span className="chat-chip-swatch" style={{ background: r.swatch }} /> : null}
            <span className="chat-chip-label">{r.label}</span>
            {/* The space keeps the chip's text readable when copied or read aloud ("next to Bed · no free spot"). */}
            {reason ? <>{" "}<span className="chat-chip-reason">· {reason}</span></> : null}
          </li>
        );
      })}
    </ul>
  );
}

/** "Undo this" for a turn, live against the store's history (and "Redo" right after undoing it). */
function UndoControls({ step }: { step: TurnStep }) {
  // A string selector: a fresh object each render would make zustand re-render forever.
  const key = usePlanner((s) => {
    const t = turnStatus(step, s);
    return t.state === "applied" ? `applied:${t.steps}` : t.state === "undone" ? `undone:${t.canRedo ? 1 : 0}` : "gone";
  });
  const [state, n] = key.split(":");
  const status: TurnStatus =
    state === "applied" ? { state: "applied", steps: Number(n) } : state === "undone" ? { state: "undone", canRedo: n === "1" } : { state: "gone" };
  const [confirm, setConfirm] = useState(false);
  if (status.state === "gone") return null;
  if (status.state === "undone") {
    return (
      <div className="chat-undo-row">
        <span className="muted small">Undone</span>
        {status.canRedo ? (
          <button type="button" className="btn btn-quiet btn-sm" data-testid="chat-redo" onClick={() => redoTurn(step, usePlanner)}>
            Redo
          </button>
        ) : null}
      </div>
    );
  }
  const later = status.steps - 1;
  if (confirm && later > 0) {
    return (
      <div className="chat-undo-row">
        <span className="small">
          Also undoes {later} later change{later === 1 ? "" : "s"}.
        </span>
        <button type="button" className="btn btn-secondary btn-sm" data-testid="chat-undo-confirm" onClick={() => undoTurn(step, usePlanner)}>
          Undo anyway
        </button>
        <button type="button" className="btn btn-quiet btn-sm" onClick={() => setConfirm(false)}>
          Keep
        </button>
      </div>
    );
  }
  return (
    <div className="chat-undo-row">
      <button
        type="button"
        className="btn btn-quiet btn-sm chat-undo"
        data-testid="chat-undo"
        onClick={() => (later > 0 ? setConfirm(true) : undoTurn(step, usePlanner))}
      >
        <Icon.undo /> Undo this
      </button>
    </div>
  );
}

function SearchBubble({ m }: { m: ChatMessage }) {
  const s = m.search!;
  const hasDesk = usePlanner((st) => st.items.some((it) => !it.hidden && /\bdesk\b/i.test(it.name) && !/\b(?:lamp|chair)\b/i.test(it.name)));
  const running = s.status === "running";
  const now = useNow(running);
  const elapsed = Math.max(0, Math.floor((now - s.startedAt) / 1000));
  if (running) {
    return (
      <div className="chat-bubble chat-progress" data-testid="chat-search-progress" role="status">
        <Spinner />
        <div className="progress-text">
          <strong>Searching the web… {elapsed}s</strong>
          <span className="muted small">
            “{s.query}”{s.forItemName ? ` for ${s.forItemName}` : ""}. Live searches take 1–3 minutes.
          </span>
        </div>
        <button type="button" className="btn btn-secondary btn-sm" data-testid="chat-search-cancel" onClick={() => useUI.getState().cancelSearch()}>
          Cancel
        </button>
      </div>
    );
  }
  if (s.status !== "done") {
    return (
      <div className={`chat-bubble${s.status === "error" ? " chat-error" : " chat-note"}`}>
        {s.status === "error" ? `Search for “${s.query}” failed: ${s.error ?? "unknown error"}` : `Search for “${s.query}” stopped.${s.error ? ` ${s.error}` : ""}`}
        {s.resend ? (
          <div>
            <button type="button" className="btn btn-secondary btn-sm" data-testid="chat-search-resend" onClick={() => useChat.getState().resendSearch(m.id)}>
              Resend
            </button>
          </div>
        ) : null}
      </div>
    );
  }
  const list = s.candidates ?? [];
  const hint = resultsHint(list, hasDesk);
  return (
    <div className="chat-bubble chat-results" data-testid="chat-results">
      <div className="chat-text">
        {list.length ? (
          <>
            Found {list.length} product{list.length === 1 ? "" : "s"} for “{s.query}”. Say “{hint}”, or use the buttons.
          </>
        ) : (
          <>No products found for “{s.query}”. Try a broader description.</>
        )}
        {s.mock ? (
          <>
            {" "}
            <Badge>demo data</Badge>
          </>
        ) : null}
      </div>
      {s.notes ? <p className="muted small chat-results-notes">{s.notes}</p> : null}
      {list.length ? (
        <ol className="chat-result-list">
          {list.map((c, i) => (
            <ChatResultCard key={c.id} c={c} index={i} />
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function ChatResultCard({ c, index }: { c: ProductCandidate; index: number }) {
  const units = usePlanner((s) => s.units);
  const previewing = usePlanner((s) => s.preview?.id === c.id);
  const targetId = usePlanner((s) => (s.items.some((it) => it.id === s.previewTargetId) ? s.previewTargetId : null));
  const price = formatPrice(c.price, c.currency);
  const link = httpUrl(c.url);
  const { setPreview, addProduct, replaceItemWithProduct, select } = usePlanner.getState();
  return (
    <li className={`chat-result${previewing ? " previewing" : ""}`} data-testid="chat-results-card">
      <div className="chat-result-thumb">
        <ProductImage src={httpUrl(c.imageUrl)} alt={c.name} product={c} />
        <span className="chat-result-index">{index + 1}</span>
      </div>
      <div className="chat-result-body">
        <div className="chat-result-title">
          <span className="chat-result-name">{c.name}</span>
          {price ? <span className="price">{price}</span> : null}
        </div>
        <div className="chat-result-meta">
          {c.retailer} · {formatDims(c.dims, units)}
          {c.dimsSource === "estimated" ? (
            <>
              {" "}
              <Badge tone="warn">est.</Badge>
            </>
          ) : null}
        </div>
        {c.style.length ? (
          <ul className="chips chat-result-styles" aria-label="Style">
            {c.style.slice(0, 3).map((t, i) => (
              <li key={`${t}-${i}`} className="chip">
                {t}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="chat-result-actions">
          <button
            type="button"
            className={`btn btn-sm ${previewing ? "btn-accent-soft" : "btn-secondary"}`}
            data-testid="chat-result-preview"
            aria-pressed={previewing}
            onClick={() => setPreview(previewing ? null : c)}
          >
            {previewing ? "Hide" : "Preview"}
          </button>
          {targetId ? (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              data-testid="chat-result-use"
              onClick={() => {
                replaceItemWithProduct(targetId, c);
                setPreview(null);
              }}
            >
              Use here
            </button>
          ) : null}
          <button
            type="button"
            className={`btn btn-sm ${targetId ? "btn-secondary" : "btn-primary"}`}
            data-testid="chat-result-add"
            onClick={() => {
              const id = addProduct(c);
              setPreview(null);
              select(id);
            }}
          >
            Add
          </button>
          {link ? (
            <a className="link small" href={link} target="_blank" rel="noopener noreferrer" data-testid="chat-result-link">
              View ↗
            </a>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function BuildBubble({ m }: { m: ChatMessage }) {
  const b = m.build!;
  const units = usePlanner((s) => s.units);
  const running = b.status === "running";
  const now = useNow(running);
  const elapsed = b.startedAt ? Math.max(0, Math.floor((now - b.startedAt) / 1000)) : 0;
  const { confirmBuild } = useChat.getState();

  if (b.status === "confirm") {
    const n = b.replaceCount ?? 0;
    return (
      <div className="chat-bubble chat-confirm" data-testid="chat-build-confirm" role="alert">
        <div className="chat-text">
          Building from {b.photos === 1 ? "this photo" : `these ${b.photos} photos`} replaces the current room and its {n} added item
          {n === 1 ? "" : "s"} (you can undo).
        </div>
        <div className="confirm-actions">
          <button type="button" className="btn btn-primary btn-sm" data-testid="chat-build-confirm-btn" onClick={() => confirmBuild(m.id, true)}>
            Replace room
          </button>
          <button type="button" className="btn btn-secondary btn-sm" data-testid="chat-build-keep" onClick={() => confirmBuild(m.id, false)}>
            Keep current
          </button>
        </div>
      </div>
    );
  }
  if (running) {
    return (
      <div className="chat-bubble chat-progress" data-testid="chat-build-progress" role="status">
        <Spinner />
        <div className="progress-text">
          <strong>Analyzing photos… {elapsed}s</strong>
          <span className="muted small">This usually takes 30–90 seconds.</span>
        </div>
        <button type="button" className="btn btn-secondary btn-sm" data-testid="chat-build-cancel" onClick={() => useUI.getState().cancelBuild()}>
          Cancel
        </button>
      </div>
    );
  }
  if (b.status === "kept") return <div className="chat-bubble chat-note">Kept the current room.</div>;
  if (b.status === "done" && b.room) {
    return (
      <div className="chat-bubble" data-testid="chat-build-done">
        <div className="chat-text">
          Built <strong>{b.room.name}</strong>: {formatLength(b.room.width, units)} × {formatLength(b.room.depth, units)},{" "}
          {formatLength(b.room.height, units)} ceiling, {b.room.items} piece{b.room.items === 1 ? "" : "s"} of furniture found.
          {b.mock ? (
            <>
              {" "}
              <Badge>demo data</Badge>
            </>
          ) : null}
        </div>
        {b.notes ? <p className="muted small chat-results-notes">{b.notes}</p> : null}
        <div className="chat-via">Everything stays editable: ask me to move or resize anything.</div>
      </div>
    );
  }
  return (
    <div className={`chat-bubble${b.status === "error" ? " chat-error" : " chat-note"}`} role={b.status === "error" ? "alert" : undefined}>
      {b.status === "error" ? `Couldn't build the room: ${b.error ?? "unknown error"}` : (b.error ?? "Room build cancelled.")}
      {b.status === "error" && b.resend ? (
        <div>
          <button type="button" className="btn btn-secondary btn-sm" data-testid="chat-build-resend" onClick={() => useChat.getState().resendBuild(m.id)}>
            Resend
          </button>
        </div>
      ) : null}
    </div>
  );
}
