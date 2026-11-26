// Tiny trend bot — agent-fun/bars-replay/v1
//
// Reads hello / batch / done lines (NDJSON) on stdin, answers every batch
// with one reply line carrying its orders on stdout.
//
// Strategy (written from the protocol schema, no outside data):
//   Multi-asset moving-average trend following. For each symbol, hold it
//   while its fast average sits above its slow average and its medium-term
//   momentum is positive; otherwise sit in USDC. Exits also fire on a
//   trailing stop or a hard stop below the entry price, which caps the
//   drawdown of any single leg. Positions are equal-weighted so no single
//   symbol can dominate the book, and the bot only trades when a signal
//   flips or a position drifts far from target, so fees stay small.
//
// Everything is deterministic: the same hello/batch stream always yields
// the same reply stream. No randomness, no clock, no network, no files.

const FAST = 6; // fast average length, in bars (hours)
const SLOW = 24; // slow average length, in bars (hours)
const MOM_BARS = 24; // momentum lookback, in bars
const MOM_MIN = 0; // minimum medium-term momentum to enter (deadband vs noise)
const TARGET_W = 0.14; // target weight of equity per held symbol
const REBALANCE_W = 0.03; // rebalance only if weight drifts this far (of equity)
const STOP_PCT = 0.05; // hard stop below entry price
const TRAIL_PCT = 0.05; // trailing stop below the peak since entry
const MIN_TRADE_USDC = 5; // ignore dust-sized adjustments
const CAP_SAFE = 0.24; // never size a buy past 24% of equity: the harness
// re-checks the 25% cap at fill time against the fill price, so sizing
// exactly to the cap can be rejected by a hair of price movement
const MAX_SLIPPAGE_BPS = 300; // reject a fill that slipped further than this

type BarMsg = {
  symbol: string;
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
};

type FillMsg = {
  client_id: string;
  symbol: string;
  side: string;
  status: string;
  price: string;
  qty: string;
};

type PositionMsg = { symbol: string; qty: string; cost_quote_units: string };

type Order = {
  side: "buy" | "sell";
  client_id: string;
  symbol: string;
  notional_quote_units?: string;
  qty?: string;
  max_slippage_bps: number;
};

type SymInfo = { symbol: string; price_scale: number; qty_scale: number };

let symbols: SymInfo[] = [];
let warmupBars = 0;
let feeBps = 10; // filled in from hello; a buy costs notional + fee, so
// buys are sized against cash net of that fee
let barCount = 0;

const closes: Record<string, number[]> = {};
const entry: Record<string, number> = {}; // entry price per held symbol
const peak: Record<string, number> = {}; // peak close since entry, per symbol
const noBuyBefore: Record<string, number> = {}; // barCount before which a symbol is not re-bought (set after a rejected buy, so a fill that missed the cap or the cash is not retried forever unchanged)

function priceOf(sym: string, raw: string): number {
  const info = symbols.find((s) => s.symbol === sym);
  return Number(raw) / 10 ** (info ? info.price_scale : 0);
}

function qtyOf(sym: string, raw: string): number {
  const info = symbols.find((s) => s.symbol === sym);
  return Number(raw) / 10 ** (info ? info.qty_scale : 0);
}

function avg(xs: number[], n: number): number {
  let s = 0;
  for (let i = xs.length - n; i < xs.length; i++) s += xs[i];
  return s / n;
}

// True when the symbol is in an uptrend worth holding.
function trendOn(sym: string): boolean {
  const cs = closes[sym];
  if (!cs || cs.length < SLOW) return false;
  const fast = avg(cs, FAST);
  const slow = avg(cs, SLOW);
  const last = cs[cs.length - 1];
  const mom = last / cs[cs.length - 1 - MOM_BARS] - 1;
  return fast > slow && last > slow && mom > MOM_MIN;
}

// True when a held position must be closed for risk reasons.
function stopHit(sym: string): boolean {
  const cs = closes[sym];
  const e = entry[sym];
  if (!cs || e === undefined) return false;
  const last = cs[cs.length - 1];
  if (last < e * (1 - STOP_PCT)) return true;
  const p = peak[sym];
  if (p !== undefined && last < p * (1 - TRAIL_PCT)) return true;
  return false;
}

function handleBatch(msg: any): void {
  const seq: number = msg.seq;
  const bars: BarMsg[] = msg.bars || [];
  const fills: FillMsg[] = msg.fills || [];
  const account = msg.account || { cash_quote_units: "0", positions: [], equity_quote_units: "0" };

  barCount += 1;

  for (const b of bars) {
    const p = priceOf(b.symbol, b.c);
    if (!closes[b.symbol]) closes[b.symbol] = [];
    closes[b.symbol].push(p);
  }

  // Account positions are the source of truth for what we hold.
  const held: Record<string, { qty: number; qtyRaw: string; value: number }> = {};
  for (const pos of account.positions as PositionMsg[]) {
    const price = closes[pos.symbol] ? closes[pos.symbol][closes[pos.symbol].length - 1] : 0;
    const q = qtyOf(pos.symbol, pos.qty);
    held[pos.symbol] = { qty: q, qtyRaw: pos.qty, value: q * price };
  }

  // Learn entry prices from fills, and forget symbols we no longer hold.
  for (const f of fills) {
    if (f.status === "rejected" && f.side === "buy") {
      noBuyBefore[f.symbol] = barCount + 3;
      continue;
    }
    if (f.status !== "filled") continue;
    const p = priceOf(f.symbol, f.price);
    if (f.side === "buy") {
      const prev = held[f.symbol];
      if (entry[f.symbol] === undefined) {
        entry[f.symbol] = p;
      } else if (prev) {
        // Weighted average entry when adding to a position.
        const addQty = qtyOf(f.symbol, f.qty);
        const oldQty = Math.max(prev.qty - addQty, 0);
        entry[f.symbol] = (entry[f.symbol] * oldQty + p * addQty) / Math.max(oldQty + addQty, 1e-12);
      }
      if (peak[f.symbol] === undefined || p > peak[f.symbol]) peak[f.symbol] = p;
    }
  }
  for (const sym of Object.keys(entry)) {
    if (!held[sym]) {
      delete entry[sym];
      delete peak[sym];
    }
  }
  // Any held symbol without a known entry (e.g. a fill we missed) starts
  // tracking from the latest close.
  for (const sym of Object.keys(held)) {
    const cs = closes[sym];
    if (!cs || cs.length === 0) continue;
    const last = cs[cs.length - 1];
    if (entry[sym] === undefined) entry[sym] = last;
    if (peak[sym] === undefined) peak[sym] = last;
    else if (last > peak[sym]) peak[sym] = last;
  }

  const orders: Order[] = [];
  let orderNo = 0;
  const nextId = (): string => `o${seq}n${orderNo++}`;

  const equity = Number(account.equity_quote_units) / 1e6;
  let cash = Number(account.cash_quote_units) / 1e6;
  if (equity <= 0) {
    sendReply(seq, orders);
    return;
  }

  const canTrade = barCount > warmupBars;

  // Sells first: they free cash for any buys decided in the same batch.
  let sellProceeds = 0;
  for (const b of bars) {
    const sym = b.symbol;
    const pos = held[sym];
    if (!pos) continue;
    const cs = closes[sym];
    if (!cs || cs.length < SLOW) continue;
    if (!canTrade) continue;
    if (!trendOn(sym) || stopHit(sym)) {
      orders.push({
        side: "sell",
        client_id: nextId(),
        symbol: sym,
        qty: pos.qtyRaw,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      sellProceeds += pos.value;
    }
  }

  // Buys and rebalances, sized against cash plus sells decided above.
  let spendable = cash + sellProceeds;
  for (const b of bars) {
    const sym = b.symbol;
    const cs = closes[sym];
    if (!cs || cs.length < SLOW) continue;
    if (!canTrade) continue;
    if (!trendOn(sym) || stopHit(sym)) continue;
    if (barCount < (noBuyBefore[sym] || 0)) continue;
    const price = cs[cs.length - 1];
    const pos = held[sym];
    const cur = pos ? pos.value : 0;
    const target = TARGET_W * equity;
    const diff = target - cur;
    if (diff > Math.max(MIN_TRADE_USDC, REBALANCE_W * equity)) {
      // Buy up to the target, never beyond the safe cap and never more
      // cash than we (will) have, net of the fee charged on top.
      const room = CAP_SAFE * equity - cur;
      const afford = spendable / (1 + feeBps / 10000 + 0.0005);
      const want = Math.min(diff, room, afford);
      if (want >= MIN_TRADE_USDC) {
        orders.push({
          side: "buy",
          client_id: nextId(),
          symbol: sym,
          notional_quote_units: String(Math.floor(want * 1e6)),
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
        spendable -= want;
      }
    } else if (diff < -Math.max(MIN_TRADE_USDC, REBALANCE_W * equity) && pos) {
      // Trim a position that drifted far above target.
      const info = symbols.find((s) => s.symbol === sym);
      const qs = info ? info.qty_scale : 0;
      const sellQty = Math.floor((-diff / price) * 10 ** qs);
      if (sellQty > 0 && sellQty < Math.floor(pos.qty * 10 ** qs)) {
        orders.push({
          side: "sell",
          client_id: nextId(),
          symbol: sym,
          qty: String(sellQty),
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        });
      }
    }
  }

  sendReply(seq, orders.slice(0, 16));
}

function sendReply(seq: number, orders: Order[]): void {
  process.stdout.write(JSON.stringify({ type: "reply", seq, orders }) + "\n");
}

function handleLine(line: string): void {
  if (!line.trim()) return;
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === "hello") {
    symbols = (msg.symbols || []).map((s: any) => ({
      symbol: s.symbol,
      price_scale: s.price_scale,
      qty_scale: s.qty_scale,
    }));
    warmupBars = typeof msg.warmup_bars === "number" ? msg.warmup_bars : 0;
    if (msg.fees && typeof msg.fees.fee_bps === "number") feeBps = msg.fees.fee_bps;
  } else if (msg.type === "batch") {
    handleBatch(msg);
  } else if (msg.type === "done") {
    process.exit(0);
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  let idx = buf.indexOf("\n");
  while (idx >= 0) {
    handleLine(buf.slice(0, idx));
    buf = buf.slice(idx + 1);
    idx = buf.indexOf("\n");
  }
});
process.stdin.on("end", () => {
  if (buf.trim()) handleLine(buf);
  process.exit(0);
});
