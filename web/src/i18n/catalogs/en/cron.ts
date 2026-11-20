/** The Study's Cron page. */
export const cron = {
  status: { interrupted: "Interrupted", error: "Last run failed", empty: "Last run gave no reply", ok: "Last run ok", never: "Not run yet" },
  enabled: "Enabled", paused: "Paused", oneShot: "One-shot", nextRun: "Next run", lastRun: "Last run", statusLabel: "Status", message: "Message",
  empty: "No scheduled jobs.", gone: "That job is no longer scheduled.",
  error: {
    cron_changed: "This job changed since you opened it. The list has been refreshed; review it and try again.",
    job_not_found: "This job no longer exists.",
    unschedulable: "This schedule has no future run left, so it cannot be resumed.",
    epoch_changed: "Tomo restarted since this page loaded. The list has been refreshed; review it and try again.",
    cron_unavailable: "The cron store could not be read or written.",
    other: "The change could not be confirmed. Refresh and check the job before trying again.",
  },
  confirm: {
    pauseTitle: "Pause “{{name}}”?", pause: "Pause job", pauseBody: "It will not run again until you resume it. A run already in progress is not stopped.",
    resumeTitle: "Resume “{{name}}”?", resume: "Resume job",
    resumeOverdue: "Its scheduled time has passed, so it will run at the scheduler's next check, within about 30 seconds.", resumeBody: "It will run again on its schedule.",
    deleteTitle: "Delete “{{name}}”?", delete: "Delete job",
    deleteBody: "The job is removed from the schedule. This cannot be undone from here. A run already in progress is not stopped.",
  },
  pause: "Pause", resume: "Resume", delete: "Delete", pauseLabel: "Pause {{name}}", resumeLabel: "Resume {{name}}", deleteLabel: "Delete {{name}}",
  schedule: "Schedule", session: "Session", working: "Working…", offline: "Changes are available while connected.",
} as const;
