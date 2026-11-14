import { useEffect, useState } from "react";
import type { WebSession, WebTask } from "../../src/web/protocol.js";
import { buildTaskView, elapsed, formatElapsed, lastStep, STATE_LABELS, taskKind } from "./tasks.js";

/** Read-only: shows what is running, never offers to stop it. */
export function TasksPanel({ tasks, sessions, onClose }: { tasks: WebTask[]; sessions: WebSession[]; onClose?: () => void }) {
  const [showAmbient, setShowAmbient] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const view = buildTaskView(tasks, sessions, showAmbient);
  const ticking = view.running > 0;
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [ticking]);
  const ambient = tasks.some((task) => task.ambient);
  return <section className="tasks" aria-labelledby="tasks-heading">
    <div className="tasks-heading"><h2 id="tasks-heading">Tasks</h2>
      {onClose && <button type="button" className="icon-button tasks-close" aria-label="Close tasks" title="Close" onClick={onClose}>
        <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg></button>}
    </div>
    {ambient && <label className="tasks-toggle"><input type="checkbox" checked={showAmbient} onChange={(e) => setShowAmbient(e.target.checked)} />Show watchers{view.hiddenAmbient ? ` (${view.hiddenAmbient})` : ""}</label>}
    <div className="tasks-list" tabIndex={0} aria-label="Task list">
    {view.groups.length === 0 ? <p className="session-note tasks-empty">Nothing running in the background.</p>
      : view.groups.map((group) => <div className="task-group" key={group.sessionId}>
        <p className="task-session">{group.title}{group.kind === "group" ? <span> · group</span> : null}</p>
        <ul>{group.rows.map(({ task, depth }) => {
          const step = lastStep(task);
          const time = formatElapsed(elapsed(task, now));
          return <li key={task.taskId} className={`task ${task.state}${depth ? " nested" : ""}`} style={{ marginLeft: depth * 16 }} title={taskKind(task)}>
            <div className="task-line"><span className="task-desc">{task.description || "Untitled task"}</span>
              {task.state === "running" && <span className="task-time">{time}</span>}</div>
            {task.state === "running"
              ? <p className="task-step"><span className="shimmer">Working</span>{step && <> · {step}</>}</p>
              : <p className="task-step">{STATE_LABELS[task.state]} · {time}</p>}
          </li>;
        })}</ul>
      </div>)}
    </div>
  </section>;
}
