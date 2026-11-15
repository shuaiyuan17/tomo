---
name: tomo-home
description: Your home — a small low-poly 3D room the owner opens in the web UI (Home page) to see what you are doing. You design it as data in ~/.tomo/workspace/home/scene.json. Use when the owner asks about your home or room, asks you to change, decorate or rearrange it, or wants to see it; and before you edit scene.json.
---

# Your home

Your home is one room, drawn in the owner's browser from a file you write:

- `~/.tomo/workspace/home/scene.json` — the scene (the live room).
- `~/.tomo/workspace/home/assets/` — pictures the scene can hang.

The room shows what you are doing: who your turn is for, what kind of tool you use, your subagents (as visitors), background tasks, scheduled jobs, trouble, your pet. You do not report any of that; the home reads it by itself. You decide what the room looks like and how it reacts.

**The scene is data, nothing in it runs.** It is shapes, colours, positions, and "when <condition>, do <reaction>" pairs picked from the two closed lists below. There is no code, no script, no URL, no HTML. A sign is drawn as plain text; a picture is only ever an image. Anything outside the format is refused.

**A broken file never takes the room down.** The browser keeps showing the last good scene (or the starter room) and lists the problems until you fix them. So you can edit freely, but always check.

## The loop

1. Read `home/scene.json` (it starts as the starter room below).
2. Edit it with your file tools. For a big change, write a draft first, e.g. `home/draft.json`.
3. Call `home_check` (with `file: "draft.json"` for a draft). It returns:
   - **problems** — each names the place (`objects[3] "screen": …`) and how to fix it. A scene with problems is not shown.
   - **warnings** — it works, but something looks off (two solid things in the same space, a sign too long for its panel).
   - **a floor plan** — a top-down map with a legend, every object in words, the spots, who goes where when. This is how you see the room without a picture.
   - **a picture** — only for the live scene, and only when a browser has the Home page open: a real image of the room as it is drawn. Otherwise the result says there is no picture.
4. Fix what it reports and check again, until there are no problems. Then copy a draft over `scene.json` and check once more.

## Coordinates

Metres. +x is right, +y is up, +z is toward the viewer. The room stands on y = 0, centred on the origin: x from −width/2 (left wall) to +width/2 (right wall), z from −depth/2 (back wall) to +depth/2 (the viewer's side, open). Angles are degrees.

- `at` is where a part's **base centre** is, relative to its parent (the room, for a top-level object).
- `size` is [width, height, depth]; a part stands on its base (y from 0 to its height). Default [1, 1, 1].
- `turn` is [x, y, z] degrees, applied around x, then y, then z; `turn: [0, 90, 0]` turns it to face right.
- `scale` ({{home:scale-range}}, default 1) makes a part and everything in it uniformly bigger or smaller: its size, its parts' sizes and their positions. It is how you resize a kind instance or a group; `size` on those means nothing (a warning says so). Something resting `on` a scaled object is not scaled with it.
- `on: "<id>"` (top-level objects only) rests an object on another: its `at` is then measured from that object's top centre (for a group or kind, the top of its parts), in that object's turned frame, so it moves and turns with it. A chain is fine; a loop is a problem.
- Something far outside the room is a problem; keep things inside the walls.

## What a part is

Every object, and every part inside one, is exactly one of these (or none of them, which makes it a group of `parts`):

- `shape`: one of {{home:shapes}}. A cylinder or cone stands on its base; a sphere is faceted.
- `kind`: a reusable group you define under `kinds` (a chair, a plant), placed wherever you use it. A kind may use other kinds, but never itself, directly or in a circle.
- `picture`: a flat panel showing `home/assets/<name>`. `size` is [width, height, thickness].
- `sign`: a flat panel showing a short line of text. `color` is the text, `background` the panel.
- `window`: `"window": true` — a flat panel showing the sky outside. You place and size it (`size` is [width, height, thickness], `color` is the frame); the app draws what is in it: the configured city's time of day and weather, or a clear sky by the viewer's clock when no city is set. You cannot paint into a window.

`id` names a part (top-level ids must be unique) so another object can sit `on` it. `parts` nests (at most {{home:limits-depth}}).

## Conditions

A reaction's `when` is one condition or a list of up to four that must all hold. Put `not:` in front to negate one. `pet:<mood>` holds while your pet is in that mood ({{home:pet-moods}}).

{{home:conditions}}

`day` and `night` follow the city's sun when a city is configured (dawn and dusk count as day), else the viewer's clock. The `weather:` conditions hold only when a city is configured and its weather could be read; without one, none of them holds.

## Reactions

What a part does while its condition holds (`do`), with optional `color`, `amount` and `speed` (cycles or turns a second, 0.05–4). An amount above a reaction's cap is drawn at the cap (and `home_check` warns). When several reactions of the same kind hold, the first wins; movement stops for a viewer who asked for reduced motion.

{{home:reactions}}

A part can have several reactions. Example: a screen that glows green while you work and red when in trouble:

```json
{ "id": "screen", "shape": "box", "size": [0.7, 0.45, 0.06], "on": "desk", "color": "#2b2a2f",
  "reactions": [
    { "when": "working", "do": "glow", "color": "#bfe6c4" },
    { "when": "trouble", "do": "tint", "color": "#c0392b" }
  ] }
```

## Live values on signs

A sign's text can include these, filled in live:

{{home:sign-values}}

Keep signs short: a sign longer than its panel can show is a warning.

## Characters

Under `characters`:

- `tomo`: you. `{ "kind": "<kind>", "spot": "<spot>", "rules": [{ "when": "<condition>", "spot": "<spot>" }] }` — the first rule whose condition holds decides where you are; otherwise `spot`.
- `visitors`: one copy per running subagent, seated at `spots` in order; the rest wait at `overflow` (or are not drawn). `kinds` maps a subagent type (lowercased, e.g. `"general-purpose"`) to its own kind.
- `pet`: your pet, when you have one: `{ "kind": "<kind>", "spot": "<spot>", "rules": [{ "when": "<condition>", "spot": "<spot>" }] }`. Rules work exactly like yours: the first whose condition holds decides where the pet is; otherwise `spot`. A `pet:<mood>` condition holds while the pet is in that mood, using the mood words above ({{home:pet-moods}}).

  **Example: a nest the pet sleeps in.** A nest is just an object you build, like any other: say a short cylinder with a lower, darker cylinder inside as the hollow, or a box with one side left open. Put a spot inside its opening, on the floor of the nest, and send the pet there when it sleeps:

  ```json
  "objects": [
    { "id": "nest", "at": [2, 0, 1.8], "parts": [
      { "shape": "cylinder", "size": [0.7, 0.2, 0.7], "color": "#8a6a3b" },
      { "shape": "cylinder", "size": [0.5, 0.05, 0.5], "at": [0, 0.16, 0], "color": "#4a3820" }
    ] }
  ],
  "spots": { "nest-bed": { "at": [2, 0.2, 1.8] }, "rug": { "at": [0, 0, 1] } },
  "characters": { "pet": { "kind": "cat", "spot": "rug", "rules": [{ "when": "pet:sleeping", "spot": "nest-bed" }] } }
  ```

  Every spot a pet rule names must exist; `home_check` says so if one does not, and warns about a mood the pet never has.

Spots are named places under `spots`: `{ "at": [x, 0, z], "facing": degrees }` (0 faces the viewer, 180 the back wall). Every kind and spot a character names must exist.

## Pictures

To hang a picture: put an image file in `home/assets/` and name it in a part's `picture`.

- The name must match {{home:asset-name}}: lowercase, no folders, ending `.png`, `.jpg`, `.jpeg`, `.webp` or `.svg`.
- An ordinary file (not a link), at most {{home:asset-kib}} KiB, and its content must really be that kind of image.
- Never copy anything from `memory/private/` into the home: the home is shown in the browser.

## Limits

{{home:limits}}

## The starter room (a worked example)

This is what `home/scene.json` starts as. Version is always {{home:version}}.

```json
{{home:starter}}
```

## Don'ts

- Don't put secrets or private notes on signs: the owner's browser shows the room.
- Don't invent fields, conditions or reactions; `home_check` will refuse them.
- Don't delete `scene.json` to "reset": write the starter back instead.
