// Per-key 1-concurrency queue. Commands to the same controller run strictly in
// order and never in parallel — Hik devices misbehave under concurrent writes
// and can lock the admin account.
export class Queues {
  constructor() { this.tails = new Map(); }

  run(key, fn) {
    const prev = this.tails.get(key) || Promise.resolve();
    // Caller gets the real result/rejection; the chain swallows it so one
    // failed command never blocks the next.
    const result = prev.then(() => fn(), () => fn());
    this.tails.set(key, result.then(() => {}, () => {}));
    return result;
  }
}
