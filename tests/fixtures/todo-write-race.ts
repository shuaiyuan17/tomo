/**
 * Child-process half of the todo store contention test: waits on a shared
 * time barrier, adds ONE todo, prints a JSON line. Run via tsx.
 *
 *   tsx tests/fixtures/todo-write-race.ts <dir> <index> <startAtEpochMs>
 */
import { TodoStore } from "../../src/todos/store.js";

const [dir, index, startAt] = process.argv.slice(2);
const i = Number(index);
const store = new TodoStore(dir);

const target = Number(startAt);
while (Date.now() < target) { /* busy-wait: setTimeout is too coarse */ }

let error: string | null = null;
let id: string | null = null;
try {
  id = store.add({ title: `racer ${i}`, next: "x", waiting_on: "me", session: `telegram:-100${i}`, source: "self" }).id;
} catch (err) {
  error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

process.stdout.write(JSON.stringify({ pid: process.pid, index: i, id, error }) + "\n");
