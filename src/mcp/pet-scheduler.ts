import { PetStore } from "./pet-store.js";
import { log } from "../logger.js";
import type { Agent } from "../agent.js";

const TICK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export class PetScheduler {
  private agent: Agent;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(agent: Agent) {
    this.agent = agent;
  }

  start(): void {
    log.info("Pet scheduler started");
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.info("Pet scheduler stopped");
  }

  private tick(): void {
    const store = new PetStore();
    let state = store.load();
    if (!state) return;

    const prevStage = state.stage;
    const prevHealth = Math.round(state.health);
    const prevRecovering = state.recovering;
    state = store.tick(state);
    store.save(state);

    const alerts: string[] = [];
    if (state.stage !== prevStage) {
      alerts.push(`✨ ${state.name} evolved into a ${state.stage}!`);
    }
    if (state.hunger < 20) {
      alerts.push(`${state.name} is hungry (hunger: ${Math.round(state.hunger)})`);
    }
    if (Math.round(state.health) < prevHealth - 5) {
      alerts.push(`${state.name}'s health dropped to ${Math.round(state.health)}`);
    }
    if (!prevRecovering && state.recovering) {
      alerts.push(`${state.name} collapsed and needs recovery care`);
    }
    if (prevRecovering && !state.recovering) {
      alerts.push(`${state.name} is out of recovery`);
    }
    if (state.happiness < 20) {
      alerts.push(`${state.name} seems very unhappy`);
    }

    if (alerts.length > 0) {
      const message = alerts.join("\n");
      log.info({ pet: state.name }, "Pet alert: %s", message);
      this.agent.sendNotification(message).catch((err) => {
        log.warn({ err }, "Pet scheduler: failed to send notification");
      });
    }
  }
}
