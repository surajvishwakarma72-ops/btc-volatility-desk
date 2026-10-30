import { EventEmitter } from 'node:events';

/**
 * In-process event emitter for desk real-time events (fills, trades, alerts).
 * Broadcasts events to active WebSocket connections.
 */
export const deskEvents = new EventEmitter();
deskEvents.setMaxListeners(200);

export function broadcastFill(fillRow: Record<string, unknown>): void {
  deskEvents.emit('fill', fillRow);
}

export function broadcastKillSwitchEvent(halted: boolean = true): void {
  deskEvents.emit('kill_switch', halted);
}

export function broadcastStrikeAlertEvent(alert: Record<string, unknown>): void {
  deskEvents.emit('strike_alert', alert);
  deskEvents.emit('alert', alert);
}

export function resetDeskEvents(): void {
  deskEvents.removeAllListeners();
}

