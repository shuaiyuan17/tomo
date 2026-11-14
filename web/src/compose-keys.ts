/**
 * Enter-to-send that respects input methods (Chinese/Japanese IMEs).
 *
 * `KeyboardEvent.isComposing` alone is not enough: Safari/WebKit fires
 * `compositionend` BEFORE the keydown of the Enter that confirms a
 * candidate, so that keydown reports isComposing=false and would send the
 * message. So any one of these blocks sending: isComposing, keyCode 229 (a
 * key the IME is handling), or our own flag, which compositionstart sets and
 * compositionend clears only on the next task — so the Enter right after
 * compositionend is still treated as part of the composition.
 */
export interface EnterKey { key: string; shiftKey: boolean; isComposing?: boolean; keyCode?: number }

export function createCompositionGuard(defer: (fn: () => void) => void = (fn) => { setTimeout(fn, 0); }) {
  let composing = false;
  let generation = 0;
  return {
    start() { composing = true; generation++; },
    end() { const at = ++generation; defer(() => { if (at === generation) composing = false; }); },
    /** True when this keydown should send the message (not Shift+Enter, not part of an IME composition). */
    shouldSubmit(event: EnterKey): boolean {
      if (event.key !== "Enter" || event.shiftKey) return false;
      return !(event.isComposing || event.keyCode === 229 || composing);
    },
  };
}
