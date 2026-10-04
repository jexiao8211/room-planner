// Runs the API and the web app together: `npm run dev` (tsx watch + vite dev server) or, with the
// `preview` argument, `npm start` (tsx + vite preview of release/, the last `npm run deploy:local`).
//
// The API's stdin is detached on purpose. On Windows, when the API inherited an open pipe as stdin (as it
// does under `concurrently` or any tool that pipes a server's stdio), it froze the moment the Claude
// Agent SDK started its claude.exe child: no child appeared and the event loop stopped answering. With
// stdin ignored (or a real terminal) the same request completes in ~20-40 s.
import { spawn } from "node:child_process";

const isWin = process.platform === "win32";
const preview = process.argv[2] === "preview";
const children = [
  spawn("npx", preview ? ["tsx", "server/index.ts"] : ["tsx", "watch", "server/index.ts"], { stdio: ["ignore", "inherit", "inherit"], shell: isWin }),
  spawn("npx", preview ? ["vite", "preview", "--port", "5173", "--outDir", "release"] : ["vite"], { stdio: "inherit", shell: isWin }),
];

let stopping = false;
function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null || child.pid === undefined) continue;
    // With shell: true the pid is the shell; kill the whole tree on Windows.
    if (isWin) spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    else child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 500);
}

for (const child of children) child.on("exit", (code) => stopAll(code ?? 0));
process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));
