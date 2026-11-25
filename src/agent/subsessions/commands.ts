import { joinText, type OwnerT, type OwnerText } from "../../i18n/index.js";
import type { TaskAddress } from "./address.js";
import type { SubsessionService } from "./service.js";
import { currentStep, needsOwner, TERMINAL_STATUSES, type SubsessionRecord } from "./types.js";

/** The newest tasks `/s` lists; older ones are counted. */
const LIST_MAX = 12;

/**
 * The reply to a `/s` command (everything but a message to a task). `scope`
 * is the session the owner wrote from: only its own tasks are seen or
 * changed. Throws when the task table cannot be read.
 */
export async function taskCommandReply(
  t: OwnerT<"subsessions">,
  service: SubsessionService,
  scope: string,
  address: Exclude<TaskAddress, { kind: "message" }>,
): Promise<OwnerText> {
  if (!service.available()) return t("cmd.unavailable");
  if (address.kind === "usage") return t("cmd.usage");
  if (address.kind === "list") {
    // What waits on the owner comes first, however old: past LIST_MAX it would only be counted.
    const asks = (r: SubsessionRecord) => (needsOwner(r) || (r.status === "waiting" && r.waitingOn === "owner") ? 1 : 0);
    const tasks = service.list(scope).filter((r) => r.status !== "archived")
      .sort((a, b) => asks(b) - asks(a) || b.lastActivityAt - a.lastActivityAt);
    if (tasks.length === 0) return t("cmd.empty");
    const lines = tasks.slice(0, LIST_MAX).map((r) => taskLine(t, r, service.backgroundRunning(r)));
    if (tasks.length > LIST_MAX) lines.push(t("cmd.more", { count: tasks.length - LIST_MAX }));
    return joinText(lines);
  }

  const record = service.get(address.id);
  if (!record || record.parentKey !== scope) return t("cmd.unknown", { id: address.id });

  switch (address.kind) {
    case "show":
      return taskDetail(t, record, service.backgroundRunning(record));
    case "stop": {
      if (record.status === "cancelled") return t("cmd.alreadyStopped", { id: record.id });
      if (TERMINAL_STATUSES.has(record.status)) return t("cmd.ended", { id: record.id, status: statusWord(t, record) });
      // Finished and waiting on the owner: "stop" would cancel a task whose work is done; done is what clears it.
      if (needsOwner(record)) return t("cmd.stopNeedsOwner", { id: record.id });
      const outcome = await service.cancel(record.id, "stopped by the owner (/s stop)");
      return outcome.ok ? t("cmd.stopped", { id: record.id, title: record.title }) : t("cmd.ended", { id: record.id, status: statusWord(t, record) });
    }
    case "start": {
      if (record.status !== "queued") return t("cmd.notQueued", { id: record.id, status: statusWord(t, record) });
      if (service.startTask(record.id, "started by the owner (/s start)")) return t("cmd.started", { id: record.id, title: record.title });
      // Held while the session registry can't be read: it starts, past the cap, once it can.
      if (service.isHeld(record.id)) return t("cmd.held", { id: record.id });
      return t("cmd.notQueued", { id: record.id, status: statusWord(t, service.get(record.id) ?? record) });
    }
    case "done": {
      const result = service.markDone(scope, record.id);
      if (result.ok) return t("cmd.done", { id: record.id, title: record.title });
      if (result.reason === "unknown") return t("cmd.unknown", { id: record.id });
      if (result.reason === "unreadable") return t("cmd.unavailable");
      if (result.reason === "newer") return t("cmd.newerReport", { id: record.id, action: needsOwner(result.record) ?? "" });
      return t("cmd.nothingToDo", { id: record.id, status: statusWord(t, service.get(record.id) ?? record) });
    }
    case "model": {
      const result = service.setModel(scope, record.id, address.model);
      if (result.ok) return t("cmd.modelSet", { id: record.id, model: address.model });
      if (result.error === "busy") return t("cmd.modelBusy", { id: record.id });
      if (result.error === "ended") return t("cmd.ended", { id: record.id, status: statusWord(t, record) });
      if (result.error === "unknown") return t("cmd.unknown", { id: record.id });
      return /haiku/i.test(address.model) ? t("cmd.modelHaiku") : t("cmd.modelUnknown", { model: address.model });
    }
  }
}

/** `background`: waiting(external) with its own background work still running (SubsessionService.backgroundRunning). */
function statusWord(t: OwnerT<"subsessions">, r: SubsessionRecord, background = false): OwnerText {
  if (background) return t("status.background");
  switch (r.status) {
    case "queued": return t("status.queued");
    case "active": return t("status.active");
    case "waiting": return r.waitingOn === "external" ? t("status.waitingExternal") : t("status.waitingOwner");
    case "finished": return needsOwner(r) ? t("status.needsOwner") : t("status.finished");
    case "cancelled": return t("status.cancelled");
    case "failed": return t("status.failed");
    case "archived": return t("status.archived");
  }
}

function taskLine(t: OwnerT<"subsessions">, r: SubsessionRecord, background: boolean): OwnerText {
  const values = { id: r.id, title: r.title, status: statusWord(t, r, background) };
  const step = currentStep(r);
  return step ? t("cmd.lineStep", { ...values, step }) : t("cmd.line", values);
}

function taskDetail(t: OwnerT<"subsessions">, r: SubsessionRecord, background: boolean): OwnerText {
  const lines: OwnerText[] = [t("cmd.line", { id: r.id, title: r.title, status: statusWord(t, r, background) })];
  // Working in the background: what it waits on besides is only its fallback.
  if (r.status === "waiting" && r.waitingReason) {
    lines.push(background ? t("cmd.detailFallback", { reason: r.waitingReason }) : t("cmd.detailWaiting", { reason: r.waitingReason }));
  }
  const action = needsOwner(r);
  if (action) lines.push(t("cmd.detailNeedsOwner", { action, id: r.id }));
  const step = currentStep(r);
  if (step) lines.push(t("cmd.detailStep", { step }));
  if (r.model) lines.push(t("cmd.detailModel", { model: r.model }));
  lines.push(t("cmd.detailHint", { id: r.id }));
  return joinText(lines);
}
