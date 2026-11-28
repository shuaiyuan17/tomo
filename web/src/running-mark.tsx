/**
 * In front of a running step: Tomo's own ring, drawing itself. The accent
 * colour and the motion both say "working"; with reduced motion it is the
 * still ring, and the title still shimmers.
 */
const MARK_PATH = "M 32 14 C 36 20, 32 32, 20 32 C 8 32, 5 22, 10 14 C 14 7, 26 6, 30 12";
export function RunningMark() {
  return <svg viewBox="0 0 40 40" aria-hidden="true" data-slot="running-mark" className="fill-none stroke-primary [stroke-linecap:round] [stroke-width:4.5]">
    {/* A faint ring is always there, so the mark never blinks out between passes. */}
    <path d={MARK_PATH} className="opacity-25" />
    <path pathLength={100} d={MARK_PATH} className="animate-mark [stroke-dasharray:100] motion-reduce:hidden" /></svg>;
}
