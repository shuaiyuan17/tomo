import * as p from "@clack/prompts";
import { disableAutostart, enableAutostart, isAutostartEnabled, isMacOS } from "../service.js";

export async function configAutostart(): Promise<void> {
  if (!isMacOS()) {
    p.log.info("Autostart is only supported on macOS.");
    return;
  }

  const enabled = isAutostartEnabled();
  p.log.info(`Currently: ${enabled ? "enabled" : "disabled"}`);

  const action = await p.confirm({
    message: enabled ? "Disable autostart?" : "Start Tomo automatically when you log in?",
    initialValue: !enabled,
  });
  if (p.isCancel(action) || !action) return;

  const s = p.spinner();
  s.start(enabled ? "Disabling autostart" : "Enabling autostart");
  try {
    if (enabled) {
      await disableAutostart();
      s.stop("Autostart disabled");
    } else {
      await enableAutostart();
      s.stop("Autostart enabled");
    }
  } catch (err) {
    s.stop("Failed");
    p.log.error((err as Error).message);
  }
}
