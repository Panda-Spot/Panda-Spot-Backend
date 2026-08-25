import { EventEmitter } from "node:events";

// In-process pub/sub for "a new photo just landed" notifications, keyed by
// eventId — used by Beam (camera-to-cloud FTP ingestion) so an open event
// page updates its gallery the instant a photo arrives, without polling.
// Same in-memory, single-process scope as lib/jobQueue.js's job registry.
const bus = new EventEmitter();
bus.setMaxListeners(0);

export function publishLiveEvent(eventId, payload) {
  bus.emit(`live:${eventId}`, payload);
}

export function subscribeLiveEvents(eventId, handler) {
  bus.on(`live:${eventId}`, handler);
  return () => bus.off(`live:${eventId}`, handler);
}
