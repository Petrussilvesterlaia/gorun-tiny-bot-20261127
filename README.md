[![make.fun](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/Petrussilvesterlaia/gorun-tiny-bot-20261127/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/Petrussilvesterlaia/gorun-tiny-bot-20261127/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

# Tiny Trend Bot — Beat Buy-and-Hold on Solana

A tiny paper-trading bot for the [make.fun](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1) bounty
"Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana". It speaks the
`agent-fun/bars-replay/v1` line protocol (`hello` / `batch` / `done` on stdin,
one `reply` with `orders` per `batch` on stdout) and trades hourly bars of
FARTCOIN, JITOSOL, POPCAT, RAY, SOL, WETH and WIF.

## Strategy

Multi-asset moving-average trend following, built to survive a window it has
never seen rather than to overfit the dev window:

- **Enter** a symbol while its 6-hour average sits above its 24-hour average,
  the close is above the 24-hour average, and its 24-hour momentum is
  positive. Otherwise the capital for that symbol sits in USDC.
- **Exit** when the averages cross back down, or on a 5% hard stop below the
  entry, or a 5% trailing stop below the peak since entry.
- **Sizing:** equal-weighted at 14% of equity per symbol, so all seven symbols
  can be held at once and no single symbol dominates. Buys are sized a hair
  below the 25% per-position cap and net of the fee, so fills are not rejected
  at the cap or for cash; a rejected buy is not retried for three bars.
- **Discipline:** the bot only trades when a signal flips or a position drifts
  far from target, keeping fees small. It is fully deterministic — the same
  `hello`/`batch` stream always yields the same reply stream — with no
  randomness, no clock, no network and no files.

## Dev-window result (official local grader)

| Metric | Value |
|---|---|
| Net PnL | −171.06 USDC (buy-and-hold ≈ −863 USDC, margin ≈ +692 USDC) |
| Trades | 43 over 7 symbols |
| Max drawdown | 2.67% (limit 25%) |
| Fees | 63.99 USDC |
| Rejected orders | 0 |
| Determinism | two executions reproduced byte for byte |

## Run

Requires Node 22.18+ (the grader runs Node 22.23.4; Node 22.6–22.17 needs
`node --experimental-strip-types main.ts`).

```sh
node main.ts
```

The bot reads NDJSON protocol messages on stdin and writes one reply per
batch on stdout. It has no dependencies — only the Node standard library.

## License

MIT — see [LICENSE](LICENSE).
