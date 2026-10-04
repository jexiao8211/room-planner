import type { KeyboardEvent } from "react";
import { usePlanner } from "../state/store";
import { useUI, type SidebarTab } from "./uiStore";
import { RoomTab } from "./RoomTab";
import { AddTab } from "./AddTab";
import { FindTab } from "./FindTab";
import { ChatPanel } from "./chat/ChatPanel";
import { useChat } from "./chat/chatStore";

const TABS: { key: SidebarTab; label: string; testId: string }[] = [
  { key: "chat", label: "Chat", testId: "tab-chat" },
  { key: "room", label: "Room", testId: "tab-room" },
  { key: "add", label: "Add", testId: "tab-add" },
  { key: "find", label: "Find online", testId: "tab-find" },
];

export function Sidebar() {
  const tab = useUI((s) => s.tab);
  const setTab = useUI((s) => s.setTab);
  const itemCount = usePlanner((s) => s.items.length);
  const resultCount = useUI((s) => s.results.length);
  const searching = useUI((s) => s.search.status === "running");
  const building = useUI((s) => s.build.status === "running");
  const thinking = useChat((s) => s.pending != null);

  const onKeyDown = (e: KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.key === tab);
    if (e.key === "ArrowRight") setTab(TABS[(i + 1) % TABS.length].key);
    else if (e.key === "ArrowLeft") setTab(TABS[(i + TABS.length - 1) % TABS.length].key);
  };

  const badge = (key: SidebarTab) => {
    if (key === "chat" && thinking) return <span className="tab-dot" title="Thinking…" />;
    if (key === "room" && building) return <span className="tab-dot" title="Building…" />;
    if (key === "find" && searching) return <span className="tab-dot" title="Searching…" />;
    if (key === "add" && itemCount) return <span className="tab-count">{itemCount}</span>;
    if (key === "find" && resultCount) return <span className="tab-count">{resultCount}</span>;
    return null;
  };

  return (
    <nav className="sidebar" aria-label="Tools">
      <div className="tabs" role="tablist" aria-label="Sidebar" onKeyDown={onKeyDown}>
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            id={`tab-${t.key}`}
            aria-selected={tab === t.key}
            aria-controls={`panel-${t.key}`}
            tabIndex={tab === t.key ? 0 : -1}
            className={`tab${tab === t.key ? " active" : ""}`}
            data-testid={t.testId}
            onClick={() => setTab(t.key)}
          >
            {t.label}
            {badge(t.key)}
          </button>
        ))}
      </div>
      {tab === "chat" ? (
        // The chat scrolls its own message list and keeps the composer pinned at the bottom.
        <div className="sidebar-chat" role="tabpanel" id="panel-chat" aria-labelledby="tab-chat">
          <ChatPanel />
        </div>
      ) : (
        <div className="sidebar-scroll" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
          {tab === "room" ? <RoomTab /> : tab === "add" ? <AddTab /> : <FindTab />}
        </div>
      )}
    </nav>
  );
}
