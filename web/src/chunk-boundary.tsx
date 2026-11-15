import { Component, Suspense, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Around a lazily loaded view (its own chunk). A chunk that fails to load
 * (a tab left open across an upgrade whose old chunk is gone, the daemon
 * down, the network dropped) would otherwise unmount the whole app, and
 * React.lazy keeps that failure: this shows it in the view's place, with
 * Reload, and the rest of the app (the draft, the live stream) stays.
 * Worded like the home room's own chunk failure.
 */
export class ChunkBoundary extends Component<{ what: string; className?: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return <Suspense fallback={null}>{this.props.children}</Suspense>;
    return <div role="note" className={cn("flex flex-col items-center justify-center gap-3 p-6 text-center text-[13px] text-muted-foreground", this.props.className)}>
      <p className="m-0 max-w-80">{this.props.what} didn't load. Reload the page to try again.</p>
      <Button variant="outline" size="sm" className="rounded-lg text-xs" onClick={() => window.location.reload()}>Reload</Button>
    </div>;
  }
}
