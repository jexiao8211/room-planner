// Example prompts shown in the empty chat. In their own module so ChatPanel.tsx only exports components
// (React Fast Refresh can't hot-swap a file that also exports plain values).
export const CHAT_EXAMPLES = [
  "Add a desk against the west wall",
  "Put a monitor on the desk",
  "Find a Japanese hanging lamp under $200 for the corner",
  "Make the room 12 by 14 feet",
];
