// The chat composer's text, persisted on every keystroke so a reload (an automatic update, a crash, closing the
// tab) never loses what the user was typing. Kept out of chatStore so typing doesn't rewrite the whole conversation.
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

export const CHAT_DRAFT_KEY = "room-planner-chat-draft-v1";
const MAX_DRAFT = 8000;

const safeLocalStorage: StateStorage = {
  getItem: (name) => {
    try {
      return globalThis.localStorage?.getItem(name) ?? null;
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      globalThis.localStorage?.setItem(name, value);
    } catch {
      // quota exceeded / storage blocked
    }
  },
  removeItem: (name) => {
    try {
      globalThis.localStorage?.removeItem(name);
    } catch {
      // ignore
    }
  },
};

interface DraftState {
  text: string;
  setText: (text: string) => void;
}

export const useChatDraft = create<DraftState>()(
  persist(
    (set) => ({
      text: "",
      setText: (text) => set({ text: text.slice(0, MAX_DRAFT) }),
    }),
    {
      name: CHAT_DRAFT_KEY,
      storage: createJSONStorage(() => safeLocalStorage),
      partialize: (s) => ({ text: s.text }),
      merge: (persisted, current) => {
        const t = (persisted as { text?: unknown } | null)?.text;
        return { ...current, text: typeof t === "string" ? t.slice(0, MAX_DRAFT) : "" };
      },
    },
  ),
);
