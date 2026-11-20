/** The read-only screen window. */
export const screen = {
  notice: {
    locked: "The Mac is locked. This is not a live picture.",
    away: "No one is signed in at the Mac's screen. This is not a live picture.",
    unconfirmed: "Can't confirm the screen is unlocked, so nothing is being captured.",
    unavailable: "The screen could not be captured. Tomo may lack the Screen Recording permission.",
    too_large: "This frame was too large to send.",
  },
  unavailable: "Screen viewing is not available on this machine.", justNow: "just now",
  status: { disconnected: "Disconnected", paused: "Paused", hidden: "Paused (tab hidden)", unavailable: "Unavailable", notLive: "Not live" },
  label: "Screen, read-only", rate: "Frame rate", rateLabel_one: "{{count}} frame per second", rateLabel_other: "{{count}} frames per second", fps: "{{value}} fps",
  fullscreen: "Full screen", close: "Close screen", alt: "The Mac's screen",
  permissionHint: "Only the desktop picture, no windows? macOS hides them without the Screen Recording permission.",
  pausedNote: "Paused.", waiting: "Waiting for the first picture…", lastPicture: "{{state}} · last picture {{age}}", resize: "Resize",
} as const;
