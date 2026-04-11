// Deferred SQS message deletion — tracks inbound message receipt handles
// until the agent sends its final reply. This ensures SQS FIFO does not
// release the next same-group message until the current one is fully processed.

const pending = new Map<string, string>();

/** Store a receipt handle for deferred deletion. Key = botId#groupJid */
export function setPendingDelete(key: string, receiptHandle: string): void {
  pending.set(key, receiptHandle);
}

/** Get a pending receipt handle. Returns undefined if none stored. */
export function getPendingDelete(key: string): string | undefined {
  return pending.get(key);
}

/** Remove a pending receipt handle after deletion. */
export function removePendingDelete(key: string): void {
  pending.delete(key);
}

/** Get all pending keys (for shutdown cleanup). */
export function getAllPendingHandles(): Map<string, string> {
  return pending;
}
