import { useEffect, useState } from "react";
import type { WebSession, WebTask } from "../../src/web/protocol.js";
import { buildTaskView, elapsed, formatElapsed, lastStep, STATE_LABELS, taskKind } from "./tasks.js";

/** Read-only: shows what is running, never offers to stop it. */
export function TasksPanel({ tasks, sessions }: { tasks: WebTask[]; sessions: WebSession[] }) {
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
    <div className="tasks-heading"><p className="eyebrow" id="tasks-heading">Working now{view.running ? ` · ${view.running}` : ""}</p>
      {ambient && <label className="tasks-toggle"><input type="checkbox" checked={showAmbient} onChange={(e) => setShowAmbient(e.target.checked)} />Show watchers{view.hiddenAmbient ? ` (${view.hiddenAmbient})` : ""}</label>}
    </div>
    {view.groups.length === 0 ? <p className="session-note tasks-empty">Nothing running in the background.</p>
      : view.groups.map((group) => <div className="task-group" key={group.sessionId}>
        <p className="task-session">{group.title}{group.kind === "group" ? <span> · group</span> : null}</p>
        <ul>{group.rows.map(({ task, depth }) => {
          const step = lastStep(task);
          return <li key={task.taskId} className={`task ${task.state}`} style={{ marginLeft: depth * 14 }}>
            <div className="task-line"><i aria-hidden="true" /><span className="task-desc">{task.description || "Untitled task"}</span></div>
            <div className="task-meta"><span>{taskKind(task)}</span><span>{task.state === "running" ? "" : `${STATE_LABELS[task.state]} · `}{formatElapsed(elapsed(task, now))}</span></div>
            {step && <p className="task-step">{step}</p>}
          </li>;
        })}</ul>
      </div>)}
  </section>;
}
