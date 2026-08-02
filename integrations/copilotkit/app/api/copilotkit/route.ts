import {
  CopilotRuntime,
  ExperimentalEmptyAdapter,
  copilotRuntimeNextJSAppRouterEndpoint,
} from "@copilotkit/runtime";
import { arenaAgentFromRequest } from "@/lib/arena/agent";

/**
 * CopilotRuntime that registers OmniArena as an AG-UI `HttpAgent`.
 *
 * Built per-request so arena session / continuation / trigger can ride in on
 * the CopilotKit client headers (`x-arena`, `x-arena-session`,
 * `x-arena-conversation`, `x-arena-thread`) — the same fields ArenaHttpAgent
 * injects into `forwardedProps` + the OmniArena request. Constructing the
 * runtime at module scope fails during `next build` (no request yet).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const serviceAdapter = new ExperimentalEmptyAdapter();

async function handle(req: Request): Promise<Response> {
  const copilotRuntime = new CopilotRuntime({
    agents: {
      arena: arenaAgentFromRequest(req),
    },
  });
  const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
    runtime: copilotRuntime,
    serviceAdapter,
    endpoint: "/api/copilotkit",
  });
  return handleRequest(req);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
