// Overlay engine: copy the committed arena files into the upstream clone, then
// weave the arena into upstream's own files with anchored patches.
//
// Every patch states the exact upstream text it expects. If assistant-ui moves
// those lines, the patch fails loudly instead of silently producing an app that
// still compiles but no longer runs the arena.
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function copyOverlay(overlayDir, upstreamDir) {
  const copied = [];
  const walk = async (relative) => {
    const entries = await readdir(path.join(overlayDir, relative), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const next = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        await walk(next);
        continue;
      }
      const target = path.join(upstreamDir, next);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, await readFile(path.join(overlayDir, next)));
      copied.push(next);
    }
  };
  await walk(".");
  return copied.sort();
}

const APP = "examples/with-ag-ui";

/**
 * `find` must appear exactly once in the file. `append` blocks are idempotent:
 * they are skipped when their marker is already present (the setup script also
 * restores tracked files to pristine upstream before patching).
 */
const PATCHES = [
  {
    file: `${APP}/app/MyRuntimeProvider.tsx`,
    find: `import { HttpAgent } from "@ag-ui/client";`,
    replace: `import { useArenaAgent } from "@/lib/arena/agent";
import { createArenaHistoryAdapter } from "@/lib/arena/history";
import { clearPersistedArena } from "@/lib/arena/persistence";
import { arenaStore } from "@/lib/arena/store";`,
  },
  {
    file: `${APP}/app/MyRuntimeProvider.tsx`,
    find: `  const agentUrl =
    (process.env.NEXT_PUBLIC_AGUI_AGENT_URL as string | undefined) ??
    "http://localhost:8000/agent";

`,
    replace: "",
  },
  {
    file: `${APP}/app/MyRuntimeProvider.tsx`,
    find: `  const agent = useMemo(() => {
    return new HttpAgent({
      url: agentUrl,
      threadId: currentThreadId,
      headers: {
        Accept: "text/event-stream",
      },
    });
  }, [agentUrl, currentThreadId]);`,
    replace: `  // OmniArena instead of the example's Python echo agent: same AG-UI client,
  // pointed at /api/arena/chat, which proxies OmniArena's ?protocol=ag-ui stream.
  const agent = useArenaAgent(currentThreadId);
  const historyAdapter = useMemo(
    () => createArenaHistoryAdapter(currentThreadId),
    [currentThreadId],
  );`,
  },
  {
    file: `${APP}/app/MyRuntimeProvider.tsx`,
    find: `      onSwitchToNewThread: async () => {
        const newId = crypto.randomUUID();
        threadsRef.current.set(newId, { id: newId, messages: [] });
        setCurrentThreadId(newId);
        console.debug("[agui] Switched to new thread:", newId);
      },`,
    replace: `      onSwitchToNewThread: async () => {
        const newId = crypto.randomUUID();
        threadsRef.current.set(newId, { id: newId, messages: [] });
        arenaStore.resetThread(currentThreadId);
        clearPersistedArena();
        setCurrentThreadId(newId);
        console.debug("[agui] Switched to new thread:", newId);
      },`,
  },
  {
    file: `${APP}/app/MyRuntimeProvider.tsx`,
    find: `    adapters: {
      threadList: threadListAdapter,
    },`,
    replace: `    adapters: {
      threadList: threadListAdapter,
      // Reloads rebuild the thread from GET /api/arena/conversations/:id.
      history: historyAdapter,
    },`,
  },
  {
    file: `${APP}/app/page.tsx`,
    find: `import { Thread } from "@/components/assistant-ui/thread";`,
    replace: `import { Thread } from "@/components/assistant-ui/thread";
import { ArenaAssistantMessage } from "@/components/arena/arena-assistant-message";
import { ArenaControls } from "@/components/arena/arena-controls";`,
  },
  {
    file: `${APP}/app/page.tsx`,
    find: `      {
        title: "Run a web search",
        label: "for recent AI news",
        prompt: "Search the web for the latest AI news.",
      },
      {
        title: "Show a browser alert",
        label: "using the alert tool",
        prompt: "Show me a browser alert saying hello!",
      },`,
    replace: `      {
        title: "Explain JWTs",
        label: "to two anonymous models",
        prompt: "Explain JSON Web Tokens in simple terms.",
      },
      {
        title: "Compare two answers",
        label: "then vote for the better one",
        prompt: "Write a haiku about distributed systems.",
      },`,
  },
  {
    file: `${APP}/app/page.tsx`,
    find: `      <Thread />`,
    replace: `      <Thread components={{ AssistantMessage: ArenaAssistantMessage }} />`,
  },
  {
    file: `${APP}/app/page.tsx`,
    find: `      <main className="relative h-dvh">
        <NewThreadButton />`,
    replace: `      <main className="relative flex h-dvh flex-col">
        <ArenaControls />
        <NewThreadButton />`,
  },
  {
    file: `${APP}/app/globals.css`,
    marker: "arena: two answers side by side",
    append: `
/* arena: two answers side by side need more room than the 44rem chat column
   assistant-ui sets inline on the thread root. */
.aui-thread-root {
  --thread-max-width: 68rem !important;
}
`,
  },
  {
    file: `${APP}/.env.example`,
    marker: "OMNIARENA_URL",
    append: `
# Where OmniArena listens. Read server-side by app/api/arena/*.
OMNIARENA_URL=http://127.0.0.1:3011
`,
  },
];

export async function applyPatches(upstreamDir) {
  const touched = new Set();
  for (const patch of PATCHES) {
    const target = path.join(upstreamDir, patch.file);
    if (!existsSync(target)) {
      throw new Error(`Patch target is missing: ${patch.file}`);
    }
    const source = await readFile(target, "utf8");

    if (patch.append) {
      if (source.includes(patch.marker)) continue;
      await writeFile(target, `${source}${patch.append}`);
      touched.add(patch.file);
      continue;
    }

    const occurrences = source.split(patch.find).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `Patch anchor matched ${occurrences} times in ${patch.file} (expected 1).\n` +
          `Upstream moved. Re-read the file at the pinned commit and update scripts/overlay.mjs.\n` +
          `Anchor:\n${patch.find}`,
      );
    }
    await writeFile(target, source.replace(patch.find, patch.replace));
    touched.add(patch.file);
  }
  return [...touched].sort();
}
