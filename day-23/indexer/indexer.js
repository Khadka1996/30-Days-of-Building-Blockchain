// Day 23 — a small, reorg-safe event indexer built on viem.
//
// The idea in one picture:
//
//   chain:  ... [n-2] ← [n-1] ← [n]        (each block points to its parent by hash)
//   saved:  cursor = n, hashes[n] = 0xabc…
//
// Every sync:
//   1. Reorg check: is the block at `cursor` still 0xabc…? If yes, every block
//      before it is unchanged too (they are chained by hash). If not, walk back
//      through the saved hashes to the newest block that still matches, delete
//      every event above it, and continue from there.
//   2. Read the head ONCE, then fetch logs in fixed ranges [from, to] up to it.
//      If the RPC says the range is too big, halve it and try again; never skip.
//   3. Save events + cursor + hashes together (one atomic write), so a crash or
//      restart can never lose or double-count an event.
//
// Events newer than `confirmations` blocks are shown as "pending": they are real,
// but a reorg could still remove them.

const EMPTY = Object.freeze([]);

class ReorgDuringFetch extends Error {}

/** true when an RPC error means "ask for fewer blocks / fewer logs". */
function isRangeError(err) {
  const text = [err?.message, err?.details, err?.shortMessage, err?.cause?.message, err?.cause?.details]
    .filter(Boolean).join(" ");
  return /range|too many|more than \d+|limit exceeded|response size/i.test(text);
}

/** viem returns bigints; JSON cannot hold them, so store them as strings. */
function plain(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  }
  return value;
}

class Indexer {
  /**
   * @param {object} o
   * @param {import('viem').PublicClient} o.client   viem public client
   * @param {{name:string,address:string,abi:any[],startBlock:number}[]} o.contracts
   * @param {{load():any, save(state:any):void}} o.store
   * @param {number} [o.confirmations=3]  blocks before an event counts as final
   * @param {number} [o.maxRange=1000]    most blocks asked for in one eth_getLogs
   * @param {number} [o.reorgWindow=128]  how many recent block hashes to keep
   */
  constructor({ client, contracts, store, confirmations = 3, maxRange = 1000, reorgWindow = 128 }) {
    if (!contracts?.length) throw new Error("no contracts to index");
    this.client = client;
    this.store = store;
    this.confirmations = confirmations;
    this.maxRange = maxRange;
    this.range = maxRange;
    this.reorgWindow = reorgWindow;

    this.contracts = contracts.map((c) => ({ ...c, address: c.address.toLowerCase() }));
    this.names = Object.fromEntries(this.contracts.map((c) => [c.address, c.name]));
    this.addresses = this.contracts.map((c) => c.address);
    this.startBlock = Math.min(...this.contracts.map((c) => c.startBlock));
    // All events of all contracts; viem decodes each log by its topic0.
    this.abiEvents = this.contracts.flatMap((c) => c.abi.filter((x) => x.type === "event"));
    this.state = null;
  }

  _fresh(chainId) {
    return {
      version: 1,
      chainId,
      addresses: this.addresses,
      cursor: this.startBlock - 1, // last block fully indexed
      head: null,                  // last chain head we saw
      hashes: {},                  // blockNumber -> blockHash (recent blocks only)
      events: {},                  // id -> event
      reorgs: [],                  // last few reorgs, for the feed
    };
  }

  /** Load saved progress, or start fresh if it belongs to another chain or contracts. */
  async init() {
    const chainId = await this.client.getChainId();
    const saved = this.store.load();
    const same = saved && saved.version === 1 && saved.chainId === chainId &&
      JSON.stringify(saved.addresses) === JSON.stringify(this.addresses);
    this.state = same ? saved : this._fresh(chainId);
    if (!same) this._save();
    return this;
  }

  _save() { this.store.save(this.state); }

  /** One round: handle any reorg, then catch up to the current head. */
  async sync() {
    if (!this.state) await this.init();
    let added = 0;
    let removed = 0;
    let reorg = null;

    // Ask the node directly: viem's getBlockNumber() is cached for 4 s by default,
    // which made the live feed lag behind the chain (finding F-01).
    const head = Number(await this.client.request({ method: "eth_blockNumber" }));

    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await this._checkReorg(head);
      if (r) { reorg = r; removed += r.removed; }
      try {
        added += await this._catchUp(head);
        break;
      } catch (err) {
        if (!(err instanceof ReorgDuringFetch)) throw err;
        // the chain changed under us: loop, re-check, continue from the cursor
      }
    }

    this.state.head = head;
    this._save();
    return { head, cursor: this.state.cursor, added, removed, reorg };
  }

  /** Fetch [cursor+1 .. head] in ranges; shrink the range when the RPC complains. */
  async _catchUp(head) {
    let added = 0;
    let from = this.state.cursor + 1;
    while (from <= head) {
      const to = Math.min(from + this.range - 1, head);
      let res;
      try {
        res = await this._fetchRange(from, to);
      } catch (err) {
        if (err instanceof ReorgDuringFetch) throw err;
        if (isRangeError(err) && to > from) {
          this.range = Math.max(1, Math.floor((to - from + 1) / 2));
          continue; // same `from`, smaller range — nothing is skipped
        }
        throw err;
      }
      for (const ev of res.events) {
        if (!this.state.events[ev.id]) { this.state.events[ev.id] = ev; added++; }
        this.state.hashes[ev.blockNumber] = ev.blockHash;
      }
      this.state.hashes[to] = res.toHash;
      this.state.cursor = to;
      this._prune();
      this._save(); // progress is saved after every range
      from = to + 1;
    }
    return added;
  }

  /** Logs for [from, to], plus the hash of block `to`, read consistently. */
  async _fetchRange(from, to) {
    const before = await this.client.getBlock({ blockNumber: BigInt(to) });
    const logs = await this.client.getLogs({
      address: this.addresses,
      events: this.abiEvents,
      fromBlock: BigInt(from),
      toBlock: BigInt(to),
      strict: true,
    });
    const after = await this.client.getBlock({ blockNumber: BigInt(to) });
    // If block `to` changed while we read, the logs may mix two forks.
    if (before.hash !== after.hash) throw new ReorgDuringFetch(`block ${to} changed during fetch`);

    const events = [];
    for (const log of logs) {
      const n = Number(log.blockNumber);
      if (log.removed || n < from || n > to) continue;
      if (n === to && log.blockHash !== before.hash) throw new ReorgDuringFetch(`log from another fork at ${to}`);
      events.push({
        id: `${log.blockHash}:${log.logIndex}`, // unique per block, so re-reads never double count
        contract: this.names[log.address.toLowerCase()],
        address: log.address,
        event: log.eventName,
        args: plain(log.args),
        blockNumber: n,
        blockHash: log.blockHash,
        txHash: log.transactionHash,
        logIndex: log.logIndex,
      });
    }
    return { events, toHash: before.hash };
  }

  /** Find the newest saved block that is still on the chain and roll back to it. */
  async _checkReorg(head) {
    const cursor = this.state.cursor;
    if (cursor < this.startBlock) return null;

    const saved = Object.keys(this.state.hashes).map(Number).sort((a, b) => b - a);
    let ancestor = this.startBlock - 1; // nothing matches → re-index everything
    for (const n of saved) {
      const block = n <= head ? await this._blockOrNull(n) : null;
      if (block && block.hash === this.state.hashes[n]) { ancestor = n; break; }
    }
    if (ancestor === cursor) return null; // the common case: no reorg

    return this._rollback(ancestor, cursor);
  }

  async _blockOrNull(n) {
    try { return await this.client.getBlock({ blockNumber: BigInt(n) }); }
    catch { return null; } // past the head on a chain that got shorter
  }

  /** Delete everything above `ancestor` and move the cursor back. */
  _rollback(ancestor, oldCursor) {
    const gone = [];
    for (const [id, ev] of Object.entries(this.state.events)) {
      if (ev.blockNumber > ancestor) { gone.push(ev); delete this.state.events[id]; }
    }
    for (const n of Object.keys(this.state.hashes)) {
      if (Number(n) > ancestor) delete this.state.hashes[n];
    }
    this.state.cursor = ancestor;
    const info = {
      at: Date.now(),
      fromBlock: ancestor + 1,
      depth: oldCursor - ancestor,
      removed: gone.length,
      removedEvents: gone.slice(0, 20),
    };
    this.state.reorgs = [info, ...this.state.reorgs].slice(0, 5);
    this._save();
    return info;
  }

  /** Keep only the recent hashes we may need to find a common ancestor. */
  _prune() {
    const keepFrom = this.state.cursor - this.reorgWindow;
    for (const n of Object.keys(this.state.hashes)) {
      if (Number(n) < keepFrom) delete this.state.hashes[n];
    }
  }

  /** Events, newest first, each with its confirmation count. */
  feed(limit = 200) {
    if (!this.state) return EMPTY;
    const head = this.state.head ?? this.state.cursor;
    return Object.values(this.state.events)
      .sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex)
      .slice(0, limit)
      .map((ev) => {
        const confirmations = head - ev.blockNumber + 1;
        return { ...ev, confirmations, status: confirmations >= this.confirmations ? "confirmed" : "pending" };
      });
  }

  /** All indexed event ids (for tests: compare against the chain itself). */
  ids() { return Object.keys(this.state?.events ?? {}).sort(); }
}

module.exports = { Indexer, ReorgDuringFetch, isRangeError, plain };
