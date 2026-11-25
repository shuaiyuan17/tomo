/**
 * Child-process half of the todo store contention test: once loaded, prints
 * `ready`, spins until the parent creates <goFile> (the shared barrier), adds
 * ONE todo, prints a JSON line. Run via tsx.
 *
 *   tsx tests/fixtures/todo-write-race.ts <dir> <index> <goFile>
 */
import { existsSync } from "node:fs";
import { TodoStore } from "../../src/todos/store.js";

const [dir, index, goFile] = process.argv.slice(2);
const i = Number(index);
const store = new TodoStore(dir);

process.stdout.write("ready\n");
// Busy-wait, not a watcher or a timer: every racer must leave the barrier
// within the same few microseconds for the adds to actually contend.
while (!existsSync(goFile)) { /* spin */ }

let error: string | null = null;
let id: string | null = null;
try {
  id = store.add({ title: `racer ${i}`, next: "x", waiting_on: "me", session: `telegram:-100${i}`, source: "self" }).id;
} catch (err) {
  error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

process.stdout.write(JSON.stringify({ pid: process.pid, index: i, id, error }) + "\n");
