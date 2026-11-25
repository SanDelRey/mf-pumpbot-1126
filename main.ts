// Breadth-velocity bot: a coin qualifies once its distinct buyers pile up fast while the curve is
// young, so the crowd is wide rather than one wallet; each entry exits on take-profit, stop or time.
import { LAMPORTS_PER_SOL, runBot, type BuyInput, type SellInput } from './vendor/makefun-bot.ts';

const STAKE = LAMPORTS_PER_SOL / 20n;
const MIN_CAP = LAMPORTS_PER_SOL / 100n;
const TAKE_PROFIT = 1.4;
const STOP_LOSS = 0.8;
const MAX_HOLD_SLOTS = 100;
const SLIP_BPS = 2_000;

const TIERS: ReadonlyArray<readonly [number, number, bigint]> = [
  [20, 10, LAMPORTS_PER_SOL],
  [40, 30, LAMPORTS_PER_SOL],
  [80, 60, 5n * LAMPORTS_PER_SOL],
];

interface Track { entry: number; slot: number }

const buyers = new Map<string, Set<string>>();
const tracks = new Map<string, Track>();
const candidates = new Set<string>();
const selling = new Set<string>();

function mid(quote: bigint, tokens: bigint): number {
  return Number(quote) / Number(tokens);
}

function qualifies(breadth: number, age: number, reserve: bigint): boolean {
  return TIERS.some(([need, maxAge, minReserve]) => breadth >= need && age <= maxAge && reserve >= minReserve);
}

await runBot({
  onHello() {},
  onBatch(state, batch) {
    const orders: Array<BuyInput | SellInput> = [];
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') { candidates.add(e.mint); buyers.set(e.mint, new Set()); }
      else if (e.event === 'TradeEvent' && e.is_buy) buyers.get(e.mint)?.add(e.user);
    }
    for (const f of batch.fills) {
      if (f.side === 'buy' && f.status === 'filled') {
        const c = state.curves.get(f.mint);
        if (c !== undefined) tracks.set(f.mint, { entry: mid(c.virtual_quote_reserves, c.virtual_token_reserves), slot: f.slot });
      }
      if (f.side === 'sell') selling.delete(f.mint);
    }
    for (const [mint, holding] of state.positions) {
      if (selling.has(mint)) continue;
      const c = state.curves.get(mint);
      const t = tracks.get(mint);
      if (c === undefined || c.complete || t === undefined) continue;
      const gain = mid(c.virtual_quote_reserves, c.virtual_token_reserves) / t.entry;
      if (gain < TAKE_PROFIT && gain > STOP_LOSS && state.slot - t.slot < MAX_HOLD_SLOTS) continue;
      orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: SLIP_BPS });
      selling.add(mint);
      if (orders.length >= state.hello.caps.max_orders_per_batch) break;
    }
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();
    let slots = state.hello.caps.max_open_positions - state.committedPositionCount();
    for (const e of batch.events) {
      if (e.event !== 'TradeEvent' || !e.is_buy || !candidates.has(e.mint)) continue;
      const c = state.curves.get(e.mint);
      if (c === undefined || c.complete || c.created_slot === null) continue;
      const breadth = buyers.get(e.mint)?.size ?? 0;
      if (!qualifies(breadth, state.slot - c.created_slot, c.real_quote_reserves)) continue;
      candidates.delete(e.mint);
      if (state.positions.has(e.mint)) continue;
      const cap = state.maxBuyLamports(e.mint);
      if (cap < MIN_CAP) continue;
      const amount = cap < STAKE ? cap : STAKE;
      if (orders.length >= state.hello.caps.max_orders_per_batch || slots <= 0) continue;
      if (free < amount + tx) continue;
      orders.push({ side: 'buy', mint: e.mint, quote_lamports: amount, max_slippage_bps: SLIP_BPS });
      free -= amount + tx;
      slots -= 1;
    }
    return orders;
  },
});
