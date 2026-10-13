/**
 * The Analyst's side of the wall.
 *
 * This extension is deliberately thin. It registers one model provider (the
 * endpoint the app is configured for) and four read-only tools, and every tool
 * is a proxy: the call is forwarded to the app over a loopback bridge, and the
 * app answers with the same code the UI itself runs. Nothing about how a
 * transcript is read lives here, so there is exactly one place to fix a parser
 * and exactly one place to decide what the Analyst may touch.
 *
 * Two variables come from the app: TM_BRIDGE (the loopback address) and
 * TM_TOKEN (a secret drawn per run). Every request carries the token, so a page
 * in some browser cannot reach the bridge even though it sits on localhost.
 */

import { Type } from "typebox";

/** The tools this extension exposes. Anything else is refused below. */
const READ_TOOLS = new Set(["tm_context", "tm_sessions", "tm_trace", "tm_search"]);

function text(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export default async function (pi) {
  const base = String(process.env.TM_BRIDGE || "").replace(/\/+$/, "");
  const token = String(process.env.TM_TOKEN || "");
  if (!base) {
    throw new Error("TM_BRIDGE is not set: start the Analyst from the app, not by hand");
  }
  const headers = { "x-tm-token": token, "content-type": "application/json" };

  async function request(path, init) {
    const res = await fetch(base + path, { ...init, headers });
    const body = await res.text();
    try {
      return JSON.parse(body);
    } catch {
      return { error: "the app sent a reply that is not JSON", raw: body.slice(0, 400) };
    }
  }

  const call = (tool, args) =>
    request("/call", { method: "POST", body: JSON.stringify({ tool, args: args || {} }) });

  // ---------------------------------------------------------------- provider
  // Read the endpoint once, at startup: the factory may be async and pi waits
  // for it, so the provider is in place before the first turn.
  const provider = await request("/provider").catch(() => null);
  if (provider && provider.baseUrl) {
    pi.registerProvider("tracematter", {
      name: provider.name || "TraceMatter",
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey || "",
      api: "openai-completions",
      models: Array.isArray(provider.models) ? provider.models : [],
    });
  }

  // ------------------------------------------------------------------- tools
  pi.registerTool({
    name: "tm_context",
    label: "Workspace context",
    description:
      "What the app currently has in scope: the active folder, the folders that were added, the model that answers, and the tools available.",
    promptSnippet: "tm_context: the app's active folder, known folders, and model",
    promptGuidelines: [
      "Call tm_context first in a conversation, before asking for sessions or traces.",
    ],
    parameters: Type.Object({}),
    async execute() {
      return text(await call("tm_context"));
    },
  });

  pi.registerTool({
    name: "tm_sessions",
    label: "List sessions",
    description:
      "Scan a folder and list the transcripts found in it: one row per session with the path, how many steps it has, its first prompt, and when it ran.",
    promptSnippet: "tm_sessions: list the transcripts in a folder",
    promptGuidelines: [
      "Use tm_sessions to discover paths before calling tm_trace, which needs one.",
      "Omit root to scan the folder that is active in the app.",
    ],
    parameters: Type.Object({
      root: Type.Optional(
        Type.String({ description: "folder to scan; defaults to the active one" }),
      ),
    }),
    async execute(_id, params) {
      return text(await call("tm_sessions", params));
    },
  });

  pi.registerTool({
    name: "tm_trace",
    label: "Read trace",
    description:
      "Read one transcript: the session summary, the steps in order with their tool calls and results, the turn segments, and the files and commands it touched.",
    promptSnippet: "tm_trace: read one transcript step by step",
    promptGuidelines: [
      "Pass a path that tm_sessions returned, or one the user pasted.",
      "Long transcripts are clipped: pass limit to focus on the first N steps.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "path of the transcript to read" }),
      limit: Type.Optional(
        Type.Number({ description: "how many steps to read from the start" }),
      ),
    }),
    async execute(_id, params) {
      return text(await call("tm_trace", params));
    },
  });

  pi.registerTool({
    name: "tm_search",
    label: "Search traces",
    description:
      "Search the transcripts of a folder, case-insensitively, and return the matching lines with their file and line number.",
    promptSnippet: "tm_search: find a string across the transcripts of a folder",
    promptGuidelines: [
      "Prefer tm_search over reading whole transcripts when you are looking for an error message, a command, or a file name.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "text to look for" }),
      root: Type.Optional(
        Type.String({ description: "folder to search; defaults to the active one" }),
      ),
    }),
    async execute(_id, params) {
      return text(await call("tm_search", params));
    },
  });

  // -------------------------------------------------------------------- gate
  // The Analyst is read-only by construction: the kernel starts without its
  // built-in tools, and anything that is not one of ours is refused here. The
  // reason is handed back to the model, so it can correct itself rather than
  // stall.
  pi.on("tool_call", async (event) => {
    if (!READ_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason:
          "This session is read-only. The tools available here are: " +
          [...READ_TOOLS].join(", ") +
          ".",
      };
    }
  });
}
