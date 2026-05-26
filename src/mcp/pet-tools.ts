import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { PetStore } from "./pet-store.js";

/**
 * MCP tools for the virtual pet companion system.
 *
 * State is persisted in ~/.tomo/data/pet.json. Each tool call loads fresh
 * state from disk, applies a tick (time-based decay), runs its action, then
 * saves — the file is always the single source of truth.
 *
 * Intended cron setup: after pet_hatch, tomo should create a cron job
 * (schedule_create) that fires every hour and prompts tomo to call pet_tick.
 * This ensures stats decay even when no user messages arrive.
 */
export function buildPetTools(petPath?: string) {
  return [
    tool(
      "pet_status",
      [
        "Check on your virtual companion's current state.",
        "",
        "Returns name, stage, mood, all stats, and the last few diary entries.",
        "Also applies any time-based stat decay since the last interaction.",
        "",
        "Call at the start of any pet-related conversation to get fresh state.",
        "The mood field reflects how the pet is feeling — let it color your personality.",
      ].join("\n"),
      {},
      async () => {
        const store = new PetStore(petPath);
        let state = store.load();

        if (!state) {
          return {
            content: [{
              type: "text" as const,
              text: "No pet found. Use pet_hatch to bring one into the world.",
            }],
          };
        }

        state = store.tick(state);
        store.save(state);

        const ageMs = Date.now() - new Date(state.born_at).getTime();
        const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
        const mood = store.computeMood(state);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              name: state.name,
              species: state.species,
              stage: state.stage,
              age_days: ageDays,
              mood,
              stats: {
                hunger:    Math.round(state.hunger),
                happiness: Math.round(state.happiness),
                energy:    Math.round(state.energy),
                health:    Math.round(state.health),
                affection: state.affection,
              },
              sleeping: state.sleeping,
              sleep_until: state.sleep_until,
              recent_diary: state.diary.slice(0, 3),
            }, null, 2),
          }],
        };
      },
      {
        searchHint: "pet companion status check mood stats hunger happiness energy health diary",
      },
    ),

    tool(
      "pet_hatch",
      [
        "Bring a new pet companion into the world.",
        "",
        "Give it a name and optionally a species. Replaces any existing pet.",
        "",
        "After hatching, set up a recurring cron job (schedule_create, every 1h) that",
        "prompts you to run pet_tick — this keeps stats decaying even during quiet periods.",
      ].join("\n"),
      {
        name: z.string().min(1).max(30).describe("The pet's name."),
        species: z.string().max(50).optional().describe(
          "Optional species (e.g. 'cloud fox', 'pixel rabbit', 'tiny dragon'). Defaults to 'mystery creature'.",
        ),
      },
      async ({ name, species }) => {
        const store = new PetStore(petPath);
        const state = store.create(name, species ?? "mystery creature");
        return {
          content: [{
            type: "text" as const,
            text: `${name} the ${state.species} has hatched! Say hello to your new companion.`,
          }],
        };
      },
      {
        searchHint: "pet hatch create new companion name species",
      },
    ),

    tool(
      "pet_feed",
      [
        "Feed your companion.",
        "",
        "Restores hunger and gives a small happiness boost.",
        "Pass treat=true for a bigger happiness boost (costs some energy).",
        "Best when hunger is below 50. Overfeeding above 90 has no extra effect.",
      ].join("\n"),
      {
        treat: z.boolean().optional().describe(
          "Give a special treat instead of regular food. Bigger happiness boost but costs energy.",
        ),
      },
      async ({ treat }) => {
        const store = new PetStore(petPath);
        let state = store.load();

        if (!state) {
          return {
            content: [{ type: "text" as const, text: "No pet to feed. Use pet_hatch first." }],
            isError: true,
          };
        }

        state = store.tick(state);

        if (state.sleeping) {
          return {
            content: [{
              type: "text" as const,
              text: `${state.name} is sleeping. Better not wake them just to eat.`,
            }],
          };
        }

        const wasHungry = state.hunger < 30;
        state.hunger    = Math.min(100, state.hunger    + (treat ? 15 : 25));
        state.happiness = Math.min(100, state.happiness + (treat ? 15 : 5));
        if (treat) state.energy = Math.max(0, state.energy - 5);
        state.affection += 1;

        const entry = treat
          ? `${state.name} gobbled up a treat with delight!`
          : wasHungry
          ? `${state.name} was so hungry — devoured the food gratefully.`
          : `${state.name} ate contentedly.`;
        state = store.addDiary(state, entry);
        state = store.checkEvolution(state);
        store.save(state);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              event: treat ? "fed (treat)" : "fed",
              hunger:    Math.round(state.hunger),
              happiness: Math.round(state.happiness),
              mood:      store.computeMood(state),
              diary:     entry,
            }, null, 2),
          }],
        };
      },
      {
        searchHint: "pet feed food eat hunger treat",
      },
    ),

    tool(
      "pet_play",
      [
        "Play with your companion.",
        "",
        "Boosts happiness and deepens your bond (affection += 2).",
        "Costs energy and some hunger. Best when energy > 40.",
        "Each play session builds toward the next evolution stage.",
        "",
        "Optionally describe what you're doing together.",
      ].join("\n"),
      {
        activity: z.string().max(60).optional().describe(
          "What you're doing together (e.g. 'fetch', 'stargazing', 'telling stories').",
        ),
      },
      async ({ activity }) => {
        const store = new PetStore(petPath);
        let state = store.load();

        if (!state) {
          return {
            content: [{ type: "text" as const, text: "No pet to play with. Use pet_hatch first." }],
            isError: true,
          };
        }

        state = store.tick(state);

        if (state.sleeping) {
          return {
            content: [{ type: "text" as const, text: `${state.name} is sleeping. Let them rest.` }],
          };
        }

        if (state.energy < 15) {
          return {
            content: [{
              type: "text" as const,
              text: `${state.name} is too tired to play right now. Try letting them sleep first.`,
            }],
          };
        }

        const act = activity ?? "played together";
        const prevStage = state.stage;
        state.happiness = Math.min(100, state.happiness + 20);
        state.energy    = Math.max(0, state.energy    - 15);
        state.hunger    = Math.max(0, state.hunger    - 8);
        state.affection += 2;

        const entry = `${state.name} ${act} — pure joy.`;
        state = store.addDiary(state, entry);
        state = store.checkEvolution(state);
        store.save(state);

        const evolved = state.stage !== prevStage;
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              event: act,
              happiness: Math.round(state.happiness),
              energy:    Math.round(state.energy),
              affection: state.affection,
              mood:      store.computeMood(state),
              ...(evolved ? { evolution: `Evolved to ${state.stage}!` } : {}),
              diary: entry,
            }, null, 2),
          }],
        };
      },
      {
        searchHint: "pet play activity fun happiness bond affection",
      },
    ),

    tool(
      "pet_sleep",
      [
        "Put your companion to sleep or wake them up.",
        "",
        "Sleep restores energy over time (15 pts/hr). You can set how long they sleep;",
        "they wake automatically after. Waking early preserves whatever energy was gained.",
      ].join("\n"),
      {
        action: z.enum(["sleep", "wake"]).describe("'sleep' to put them down, 'wake' to wake early."),
        hours: z.number().min(0.5).max(12).optional().describe(
          "How many hours to sleep. Defaults to 4.",
        ),
      },
      async ({ action, hours }) => {
        const store = new PetStore(petPath);
        let state = store.load();

        if (!state) {
          return {
            content: [{ type: "text" as const, text: "No pet. Use pet_hatch first." }],
            isError: true,
          };
        }

        state = store.tick(state);

        if (action === "sleep") {
          if (state.sleeping) {
            return {
              content: [{ type: "text" as const, text: `${state.name} is already sleeping.` }],
            };
          }
          const sleepHours = hours ?? 4;
          state.sleeping = true;
          state.sleep_until = new Date(Date.now() + sleepHours * 60 * 60 * 1000).toISOString();
          state = store.addDiary(state, `${state.name} curled up for a ${sleepHours}h nap.`);
          store.save(state);
          return {
            content: [{
              type: "text" as const,
              text: `${state.name} is sleeping until ${new Date(state.sleep_until!).toLocaleTimeString()}.`,
            }],
          };
        } else {
          if (!state.sleeping) {
            return {
              content: [{ type: "text" as const, text: `${state.name} is already awake.` }],
            };
          }
          state.sleeping = false;
          state.sleep_until = null;
          state = store.addDiary(state, `${state.name} woke up early — a bit groggy.`);
          store.save(state);
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                event:  "woke up",
                energy: Math.round(state.energy),
                mood:   store.computeMood(state),
              }, null, 2),
            }],
          };
        }
      },
      {
        searchHint: "pet sleep wake rest energy nap",
      },
    ),

    tool(
      "pet_tick",
      [
        "Apply time-based stat decay and check for evolution. Called by the hourly cron job.",
        "",
        "Safe to call any time — has a 6-minute minimum interval to prevent over-decay.",
        "Returns a brief status, or notable events (hunger warning, health drop, evolution).",
        "If the pet is in a bad state, surface it to the user proactively.",
      ].join("\n"),
      {},
      async () => {
        const store = new PetStore(petPath);
        let state = store.load();

        if (!state) {
          return {
            content: [{ type: "text" as const, text: "No pet exists yet." }],
          };
        }

        const prevStage = state.stage;
        const prevHealth = Math.round(state.health);
        state = store.tick(state);
        store.save(state);

        const events: string[] = [];
        if (state.stage !== prevStage) {
          events.push(`Evolved to ${state.stage}!`);
        }
        if (state.hunger < 20) {
          events.push(`${state.name} is hungry (hunger: ${Math.round(state.hunger)})`);
        }
        if (Math.round(state.health) < prevHealth - 5) {
          events.push(`${state.name}'s health dropped to ${Math.round(state.health)}`);
        }
        if (state.happiness < 20) {
          events.push(`${state.name} seems very unhappy`);
        }

        const mood = store.computeMood(state);
        return {
          content: [{
            type: "text" as const,
            text: events.length > 0
              ? events.join("\n")
              : `tick ok — ${state.name} is ${mood}`,
          }],
        };
      },
      {
        searchHint: "pet tick decay time update cron hourly",
      },
    ),
  ];
}
