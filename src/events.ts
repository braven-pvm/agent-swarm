import { makeId } from "./ids.js";
import type { EntityType, HarnessEvent } from "./types.js";

export function createEvent(input: {
  actor: string;
  type: string;
  entityType: EntityType;
  entityId: string;
  payload?: Record<string, unknown>;
}): HarnessEvent {
  return {
    id: makeId("event"),
    timestamp: new Date().toISOString(),
    actor: input.actor,
    type: input.type,
    entityType: input.entityType,
    entityId: input.entityId,
    payload: input.payload ?? {},
  };
}
