// Turns a pristine vercel/ai-chatbot clone into the arena-mode build.
//
// Two mechanisms, deliberately kept apart:
//   1. `overlay/` files are copied in verbatim — everything arena-specific
//      (routes, components, protocol helpers) is a new file we fully own.
//   2. A short list of anchored edits below splices those files into the
//      template's own wiring. Each anchor must match exactly once; a miss is a
//      hard error naming the file, which is how a bad upstream bump surfaces.
import { cp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** @typedef {{ find: string, replace: string }} Edit */
/** @typedef {{ file: string, why: string, edits: Edit[] }} Patch */

/** @type {Patch[]} */
export const patches = [
  {
    edits: [
      {
        find: `import type { Suggestion } from "./db/schema";`,
        replace: `import type { Suggestion } from "./db/schema";
import type { ArenaMeta, ArenaReveal, ArenaSlotError } from "./arena/protocol";`,
      },
      {
        find: `  "chat-title": string;
  "waiting-status": WaitingStatusData;
};`,
        replace: `  "chat-title": string;
  "waiting-status": WaitingStatusData;
  "arena-meta": ArenaMeta;
  "arena-b-delta": { text: string };
  "arena-b-done": Record<string, never>;
  "arena-error": ArenaSlotError;
  "arena-reveal": ArenaReveal;
};`,
      },
    ],
    file: "lib/types.ts",
    why: "type the data-arena-* parts the OmniArena adapter streams",
  },
  {
    edits: [
      {
        find: `import { useDataStream } from "@/components/chat/data-stream-provider";`,
        replace: `import { useArena } from "@/components/arena/arena-provider";
import { useDataStream } from "@/components/chat/data-stream-provider";`,
      },
      {
        find: `  const { setDataStream, setWaitingStatus } = useDataStream();`,
        replace: `  const { setDataStream, setWaitingStatus } = useDataStream();
  const arena = useArena();`,
      },
      {
        find: `      setDataStream((ds) => (ds ? [...ds, dataPart] : []));`,
        replace: `      if (dataPart.type.startsWith("data-arena-")) {
        // Arena parts feed the matchup UI, not the artifact data stream.
        arena.ingestDataPart(chatId, dataPart);
        return;
      }
      setDataStream((ds) => (ds ? [...ds, dataPart] : []));`,
      },
      {
        find: `        return {
          body: {
            id: request.id,`,
        replace: `        // In arena mode this swaps the endpoint for /api/arena/chat and adds
        // the OmniArena conversation id to continue from.
        const arenaRequest = arena.prepareRequest(request.id);

        return {
          ...arenaRequest,
          body: {
            id: request.id,`,
      },
      {
        find: `            selectedVisibilityType: visibility,
            ...request.body,`,
        replace: `            selectedVisibilityType: visibility,
            ...arenaRequest.body,
            ...request.body,`,
      },
    ],
    file: "hooks/use-active-chat.tsx",
    why: "route the chat transport at the arena endpoint and capture arena data parts",
  },
  {
    edits: [
      {
        find: `import { useDataStream } from "./data-stream-provider";`,
        replace: `import { ArenaMatchup } from "@/components/arena/arena-matchup";
import { readArenaMatchup } from "@/lib/arena/protocol";
import { useDataStream } from "./data-stream-provider";`,
      },
      {
        find: `  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";`,
        replace: `  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";

  // An assistant message carrying arena parts is a matchup, not a single
  // answer: render the two blind columns and the vote controls instead.
  const arenaMatchup = readArenaMatchup(message);
  if (arenaMatchup) {
    return (
      <div
        className="group/message w-full"
        data-role={message.role}
        data-testid={\`message-\${message.role}\`}
      >
        <ArenaMatchup
          chatId={chatId}
          isStreaming={isLoading}
          matchup={arenaMatchup}
          messageId={message.id}
        />
      </div>
    );
  }`,
      },
    ],
    file: "components/chat/message.tsx",
    why: "render matchups inside the template's own message list",
  },
  {
    edits: [
      {
        find: `import {
  PromptInput,`,
        replace: `import {
  ArenaLeaderboardButton,
  ArenaModelLock,
  ArenaModeToggle,
} from "@/components/arena/arena-controls";
import {
  PromptInput,`,
      },
      {
        find: `            <ModelSelectorCompact
              onModelChange={onModelChange}
              selectedModelId={selectedModelId}
            />`,
        // The picker is replaced, not wrapped: the arena chooses the models, and
        // naming one next to a blind matchup would break the blindness the vote
        // depends on.
        replace: `            <ArenaModelLock />
            <ArenaModeToggle />
            <ArenaLeaderboardButton />`,
      },
    ],
    file: "components/chat/multimodal-input.tsx",
    why: "expose the arena toggle and leaderboard in the composer toolbar",
  },
  {
    edits: [
      {
        find: `    {
      method: "POST",
      path: "/api/chat",
    },`,
        replace: `    {
      method: "POST",
      path: "/api/chat",
    },
    {
      method: "POST",
      path: "/api/arena/chat",
    },`,
      },
    ],
    file: "instrumentation-client.ts",
    why: "register the arena endpoint with BotId like the template's own chat route",
  },
  {
    edits: [
      {
        find: `import { ActiveChatProvider } from "@/hooks/use-active-chat";`,
        replace: `import { ArenaProvider } from "@/components/arena/arena-provider";
import { ActiveChatProvider } from "@/hooks/use-active-chat";`,
      },
      {
        find: `      <DataStreamProvider>
        <Suspense fallback={<div className="flex h-dvh bg-sidebar" />}>
          <SidebarShell>{children}</SidebarShell>
        </Suspense>
      </DataStreamProvider>`,
        replace: `      <ArenaProvider>
        <DataStreamProvider>
          <Suspense fallback={<div className="flex h-dvh bg-sidebar" />}>
            <SidebarShell>{children}</SidebarShell>
          </Suspense>
        </DataStreamProvider>
      </ArenaProvider>`,
      },
    ],
    file: "app/(chat)/layout.tsx",
    why: "provide arena state above the chat tree",
  },
];

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? listFiles(full) : [full];
    }),
  );
  return files.flat();
}

export async function copyOverlay(overlayDir, upstreamDir) {
  await cp(overlayDir, upstreamDir, { recursive: true });
  const files = await listFiles(overlayDir);
  return files.map((file) => path.relative(overlayDir, file));
}

export async function applyPatches(upstreamDir) {
  for (const patch of patches) {
    const target = path.join(upstreamDir, patch.file);
    let source = await readFile(target, "utf8");

    for (const edit of patch.edits) {
      const occurrences = source.split(edit.find).length - 1;
      if (occurrences !== 1) {
        throw new Error(
          `Patch anchor for ${patch.file} matched ${occurrences} times (expected 1).\n` +
            `Purpose: ${patch.why}\n` +
            `Anchor:\n${edit.find}\n\n` +
            "The pinned upstream commit in upstream.json probably moved. Update the anchor in scripts/overlay.mjs.",
        );
      }
      source = source.replace(edit.find, edit.replace);
    }

    await writeFile(target, source);
  }
  return patches.map((patch) => patch.file);
}
