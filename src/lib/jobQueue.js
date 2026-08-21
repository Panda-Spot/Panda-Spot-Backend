import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

// In-process, in-memory job registry. No Redis, single Node process — MVP
// appropriate per server/README.md's "what this deliberately does NOT do
// yet" notes. Jobs are lost on server restart; that's an accepted
// limitation, not an oversight.
const jobs = new Map(); // jobId -> { emitter, state }

export function createJob() {
  const id = randomUUID();
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  const state = { id, done: false, lastEvent: null };
  jobs.set(id, { emitter, state });
  return { id, emitter };
}

export function emitJobEvent(jobId, event) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.state.lastEvent = event;
  if (event.type === "done" || event.type === "error") job.state.done = true;
  job.emitter.emit("event", event);
}

export function getJob(jobId) {
  return jobs.get(jobId);
}
