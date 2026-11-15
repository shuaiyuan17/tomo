import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { isAbsolute, normalize } from "node:path";
import { checkHomeSceneText } from "../home/check.js";
import { describeHomeReadError, DRAFT_NAME, HOME_DIR, listHomeAssets, readHomeJson, SCENE_FILE } from "../home/files.js";
import { renderFloorPlan } from "../home/floor-plan.js";
import { homeSceneSchema } from "../home/scene.js";
import type { HomeService } from "../home/service.js";
import { ensureStarterScene } from "../home/store.js";

/**
 * `home_check`: how Tomo checks its home. Reads the live scene (or a draft
 * in `home/` Tomo names, to check before replacing the live file), returns
 * the problems, the warnings and the floor plan as text, and, when a
 * browser has the Home page open, a real picture of the room as that
 * browser drew it.
 *
 * Owner DM only: registered only on the owner's own session
 * (internal-server.ts), and refused for a turn a summoned group is steering.
 * A group session can neither read the home through it nor ask a browser
 * for a picture.
 */

export interface HomeToolDeps {
  workspaceDir: string;
  /** Is the turn in flight the owner's own? Asked on every call. */
  allowed(): boolean;
  /** The daemon's home service (scene store and picture broker); absent: no picture. */
  service(): HomeService | undefined;
}

export const HOME_TOOL_REFUSAL = "home_check is only available in the owner's own conversation; this turn belongs to a group (or a group summoned into this one). Ask again in the owner's DM.";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/**
 * Which file in home/ Tomo means: the live scene for nothing, "scene.json",
 * "home/scene.json" or its full path; else a draft named the same ways.
 * Anything that is not a .json file directly in home/ is refused.
 */
export function resolveHomeFile(input: string | undefined, workspaceDir: string): { name: string } | { error: string } {
  const raw = (input ?? "").trim();
  if (!raw) return { name: SCENE_FILE };
  let rest = raw.replace(/\\/g, "/");
  const roots = [`${normalize(workspaceDir).replace(/\/+$/, "")}/${HOME_DIR}/`, `~/.tomo/workspace/${HOME_DIR}/`, `${HOME_DIR}/`, "./"];
  for (const root of roots) if (rest.startsWith(root)) { rest = rest.slice(root.length); break; }
  if (isAbsolute(rest) || rest.includes("/") || !DRAFT_NAME.test(rest)) {
    return { error: `${JSON.stringify(raw)} is not a file directly in ${HOME_DIR}/; name a .json file there, like "draft.json" (or leave file out to check the live scene.json).` };
  }
  return { name: rest };
}

export function buildHomeTools(deps: HomeToolDeps) {
  return [
    tool(
      "home_check",
      [
        "Check your home (the 3D room the owner sees in the web UI) and look at it.",
        "",
        `Reads ~/.tomo/workspace/${HOME_DIR}/scene.json, or a draft .json file in ${HOME_DIR}/ that you name, and returns: the problems (each says where and how to fix it; a scene with problems is not shown), warnings, and a floor plan in text (a top-down map with a legend, every object, the spots, who goes where when).`,
        "",
        "For the live scene, if a browser has the Home page open, it also returns a picture of the room as that browser drew it (waiting a few seconds). With no browser open there is no picture, and the result says so.",
        "",
        "Edit the file, call this, fix what it reports, call it again. Load the tomo-home skill for the format.",
      ].join("\n"),
      {
        file: z.string().max(400).optional().describe(`A draft to check instead of the live scene: a .json file directly in ${HOME_DIR}/, e.g. "draft.json". Omit for scene.json.`),
      },
      async ({ file }) => {
        if (!deps.allowed()) return { content: [{ type: "text" as const, text: HOME_TOOL_REFUSAL }], isError: true };
        const target = resolveHomeFile(file, deps.workspaceDir);
        if ("error" in target) return { content: [{ type: "text" as const, text: `home_check failed: ${target.error}` }], isError: true };
        const live = target.name === SCENE_FILE;
        if (live) ensureStarterScene(deps.workspaceDir);
        const read = readHomeJson(deps.workspaceDir, target.name);
        if (!read.ok) return { content: [{ type: "text" as const, text: `home_check: ${describeHomeReadError(target.name, read.error)}` }], isError: true };
        const assets = listHomeAssets(deps.workspaceDir);
        const result = checkHomeSceneText(read.text, { assets: new Set(assets.usable.map((a) => a.name)), refusedAssets: assets.refused }, target.name);
        const lines: string[] = [];
        lines.push(`home_check: ${HOME_DIR}/${target.name}: ${result.ok ? "no problems" : `${result.problems.length} problem${result.problems.length === 1 ? "" : "s"}`}${result.warnings.length ? `, ${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}` : ""}.`);
        if (result.problems.length) lines.push("", "Problems (fix these; until then the home keeps showing the last good scene):", ...result.problems.map((p) => `- ${p}`));
        if (result.warnings.length) lines.push("", "Warnings (it still works):", ...result.warnings.map((w) => `- ${w}`));
        // The plan of what was checked, even with problems, as long as its shape is readable.
        const shape = result.scene ?? (() => { try { const parsed = homeSceneSchema.safeParse(JSON.parse(read.text.replace(/^\uFEFF/, ""))); return parsed.success ? parsed.data : undefined; } catch { return undefined; } })();
        if (shape) lines.push("", renderFloorPlan(shape));
        else lines.push("", "No floor plan: the file is not yet in the scene format.");

        const content: Content[] = [];
        const service = deps.service();
        if (!live) {
          lines.push("", `Picture: none. This is a draft; browsers draw ${HOME_DIR}/scene.json. Copy it over scene.json and check again to see it.`);
        } else if (!service) {
          lines.push("", "Picture: none. The home is not running in this daemon.");
        } else {
          const view = service.store.refresh();
          const look = await service.look(view.revision);
          if (look.status === "picture") {
            const stale = look.snapshot.revision !== view.revision;
            lines.push("", `Picture: below, as an open Home page drew it${stale ? " (it may still show the previous version of the scene)" : ""}${result.ok ? "" : "; because of the problems it shows the last good scene, not this file"}.`);
            content.push({ type: "image", data: look.snapshot.png.toString("base64"), mimeType: "image/png" });
          } else {
            lines.push("", "Picture: none. No browser has the Home page open right now, so there is no picture; the floor plan above is what you have.");
          }
          const sky = service.status().sky;
          lines.push(sky ? `Outside the window now: ${sky.weather}, ${sky.phase}${sky.tempC !== undefined ? `, ${sky.tempC} °C` : ""}.`
            : "Outside the window: no weather (no city configured, or not read yet); windows show a clear sky by the viewer's clock and weather: conditions do not hold.");
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }, ...content] };
      },
      { searchHint: "home room scene 3d check floor plan picture look" },
    ),
  ];
}
