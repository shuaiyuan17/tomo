#!/usr/bin/env node
/**
 * The UI gallery: `npm run web:gallery [-- --only <substring>[,<substring>...]] [-- --dir <path>]`.
 *
 * Runs tests/gallery/*.gallery.ts (screenshots of every web UI surface and state, see
 * docs/web-ui.md) against the built assets, then writes `index.html`, a contact sheet of every
 * PNG in the folder grouped by surface, light and dark side by side.
 *
 *   --only / GALLERY_ONLY  shoot only the shots whose name contains one of the substrings; the
 *                          folder's other shots are kept, so the sheet still shows them.
 *   --dir  / GALLERY_DIR   the output folder (default test-results/gallery). Without --only it is
 *                          emptied of earlier shots first.
 *   --sheet-only           rewrite index.html from the PNGs already there; shoot nothing.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const VIEWPORTS = ["desktop", "laptop", "tablet", "phone"];
const THEMES = ["light", "dark"];

function parseArgs(argv) {
  const out = { only: process.env.GALLERY_ONLY ?? "", dir: process.env.GALLERY_DIR || "test-results/gallery", sheetOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${arg} needs a value`); return v; };
    if (arg === "--only") out.only = value();
    else if (arg.startsWith("--only=")) out.only = arg.slice(7);
    else if (arg === "--dir") out.dir = value();
    else if (arg.startsWith("--dir=")) out.dir = arg.slice(6);
    else if (arg === "--sheet-only") out.sheetOnly = true;
    else if (arg === "-h" || arg === "--help") { console.log("usage: npm run web:gallery -- [--only <substr>[,...]] [--dir <path>] [--sheet-only]"); process.exit(0); }
    else throw new Error(`unknown argument: ${arg}`);
  }
  return { ...out, dir: resolve(out.dir) };
}

const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** `<surface>-<state>-<viewport>-<theme>.png` → its parts (the state may contain hyphens). */
function parseShot(file) {
  const parts = file.replace(/\.png$/, "").split("-");
  if (parts.length < 4) return undefined;
  const theme = parts.pop(); const viewport = parts.pop(); const surface = parts.shift();
  if (!THEMES.includes(theme) || !VIEWPORTS.includes(viewport)) return undefined;
  return { file, surface, state: parts.join("-"), viewport, theme };
}

function git(args) {
  const run = spawnSync("git", args, { encoding: "utf8" });
  return run.status === 0 ? run.stdout.trim() : "";
}

function writeSheet(dir) {
  const shots = readdirSync(dir).filter((f) => f.endsWith(".png")).map(parseShot).filter(Boolean);
  let failures = [];
  try { failures = JSON.parse(readFileSync(join(dir, "failures.json"), "utf8")); } catch { /* none recorded */ }
  const surfaces = new Map();
  for (const shot of shots) {
    if (!surfaces.has(shot.surface)) surfaces.set(shot.surface, new Map());
    const states = surfaces.get(shot.surface);
    if (!states.has(shot.state)) states.set(shot.state, new Map());
    states.get(shot.state).set(`${shot.viewport}-${shot.theme}`, shot.file);
  }
  const rev = git(["rev-parse", "--short", "HEAD"]);
  const dirty = git(["status", "--porcelain", "--untracked-files=no"]) ? " (uncommitted changes)" : "";
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const nav = [...surfaces.keys()].sort().map((s) => `<a href="#${escape(s)}">${escape(s)}</a>`).join("");
  const sections = [...surfaces.keys()].sort().map((surface) => {
    const states = surfaces.get(surface);
    const blocks = [...states.keys()].sort().map((state) => {
      const byKey = states.get(state);
      const rows = VIEWPORTS.filter((vp) => THEMES.some((t) => byKey.has(`${vp}-${t}`))).map((vp) => {
        const cells = THEMES.map((t) => {
          const file = byKey.get(`${vp}-${t}`);
          return file
            ? `<figure class="${t}"><a href="${escape(file)}"><img loading="lazy" src="${escape(file)}" alt="${escape(file)}"></a><figcaption>${t}</figcaption></figure>`
            : `<figure class="missing"><div>no ${t} shot</div></figure>`;
        }).join("");
        return `<div class="row ${vp}"><h4>${vp}</h4><div class="pair">${cells}</div></div>`;
      }).join("");
      return `<section class="state" id="${escape(`${surface}-${state}`)}"><h3>${escape(state)}</h3>${rows}</section>`;
    }).join("");
    return `<section class="surface" id="${escape(surface)}"><h2>${escape(surface)}</h2>${blocks}</section>`;
  }).join("");
  const failed = failures.length
    ? `<div class="failures"><strong>${failures.length} step(s) failed:</strong><ul>${failures.map((f) => `<li><code>${escape(f.name)}</code> ${escape(f.error)}</li>`).join("")}</ul></div>`
    : "";
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tomo UI gallery</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f4ef; --fg: #1d1b18; --muted: #6b665d; --line: #ddd8cc; --card: #fff; }
  @media (prefers-color-scheme: dark) { :root { --bg: #161513; --fg: #ece8df; --muted: #9d978b; --line: #34312c; --card: #1f1e1b; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, sans-serif; }
  header { position: sticky; top: 0; z-index: 1; background: var(--bg); border-bottom: 1px solid var(--line); padding: 12px 16px; }
  header h1 { margin: 0 0 4px; font-size: 18px; }
  header p { margin: 0 0 8px; color: var(--muted); }
  nav { display: flex; flex-wrap: wrap; gap: 6px; }
  nav a { color: inherit; text-decoration: none; border: 1px solid var(--line); border-radius: 999px; padding: 2px 10px; background: var(--card); }
  main { padding: 16px; }
  .surface > h2 { margin: 24px 0 8px; font-size: 20px; border-bottom: 1px solid var(--line); padding-bottom: 4px; }
  .state > h3 { margin: 16px 0 6px; font-size: 15px; }
  .row { margin: 0 0 14px; }
  .row h4 { margin: 0 0 4px; font-size: 12px; font-weight: 500; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; align-items: start; }
  .phone .pair, .tablet .pair { grid-template-columns: repeat(2, minmax(0, 360px)); }
  figure { margin: 0; background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 6px; }
  figure img { display: block; width: 100%; height: auto; border-radius: 3px; }
  figcaption { color: var(--muted); font-size: 12px; margin-top: 4px; }
  .missing div { color: var(--muted); padding: 24px; text-align: center; }
  .failures { border: 1px solid #c0392b; border-radius: 6px; padding: 8px 12px; margin-bottom: 12px; }
  @media (max-width: 700px) { .pair, .phone .pair, .tablet .pair { grid-template-columns: 1fr; } }
</style></head>
<body>
<header><h1>Tomo UI gallery</h1>
<p>${shots.length} shots · ${escape(branch)} @ ${escape(rev)}${escape(dirty)} · ${escape(new Date().toISOString())}</p>
<nav>${nav}</nav></header>
<main>${failed}${sections}</main>
</body></html>
`;
  writeFileSync(join(dir, "index.html"), html);
  return { shots: shots.length, failures: failures.length };
}

const options = parseArgs(process.argv.slice(2));
mkdirSync(options.dir, { recursive: true });
const started = Date.now();
let status = 0;
if (!options.sheetOnly) {
  if (!existsSync(resolve("dist/web-assets/index.html"))) { console.error("ui-gallery: dist/web-assets is missing; run `npm run build` first"); process.exit(1); }
  if (!options.only) {
    for (const f of readdirSync(options.dir)) if (f.endsWith(".png") || f === "index.html") rmSync(join(options.dir, f));
  }
  rmSync(join(options.dir, "failures.json"), { force: true });
  const run = spawnSync("npx", ["vitest", "run", "--config", "vitest.gallery.config.ts"], {
    stdio: "inherit", env: { ...process.env, GALLERY_DIR: options.dir, GALLERY_ONLY: options.only },
  });
  status = run.status ?? 1;
}
const sheet = writeSheet(options.dir);
const seconds = Math.round((Date.now() - started) / 1000);
console.log(`ui-gallery: ${sheet.shots} shots in ${options.dir} (${seconds}s); contact sheet: ${join(options.dir, "index.html")}`);
if (sheet.failures) { console.error(`ui-gallery: ${sheet.failures} step(s) failed; see failures.json and the top of index.html`); status = status || 1; }
process.exit(status);
