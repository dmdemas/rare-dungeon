# Economy — Soft + Hard

Units: simulated **$**. Weekly **pool tickets** settle Sunday (sim: end of run).

## Soft

| | |
|---|---|
| Create / Entry | **$2** / **$1** |
| Clear | ~30–34% |
| Owner close | ~**1.5×** |
| Rerolls | none |
| Dungeon power | **1×** Soft-units (abs `0.4`) |
| Friend ease | **+2 STA**, **−10 fright** (free) |

## Hard

| | |
|---|---|
| Create | **$30** → bank **$27** + fee **$3** (90/10) |
| Entry | **$15** → bank **$13.5** + pool **$1.5** (90/10) |
| Friend clear | ~**11%** (~every 9) |
| Clear payout | **95%** bank |
| `minWinsBeforeClaim` | **7** |
| Suggested bank close | ROI bank ≥ **2.0×**, then hold for tickets |
| Dungeon power | **2.3×** Soft-units (abs `0.92`) |
| Friend ease | none (0) |

### Golden OR (with weekly tickets)

| Who | Target |
|---|---|
| Owner (bank claim **+** ticket $) | **~2–3×** create |
| Friend wipe on **held** bank | **~8–10×** entry |

Early-claim @ k=7 → thin pots (~4×) + weak tickets. Hold → fatter pots + riskBoost tickets.

### Rerolls (Friend + dungeon create — same ladder)

- First **$2.5**, each next **×1.5** → **100% rewardPool**
- Buy perk control, not +EV

### Reward pool + tickets

- Fees → **rewardPool** all week (burn OFF: `PROTOCOL_BURN_ENABLED`).
- **One ticket type**; only **power quantity** changes (no levels).
- Mint power on each Hard corpse: holdBonus(0.12/win) × riskBoost(×3 @ wins≥8 / raider×≥7) × postUnlockMint(×2 @ wins≥8).
- **Early claim slash:** wins &lt; 8 → keep **20%** ticket power on that dungeon.
- Week end: 20% Soft / 80% Hard → pay ∝ power → tickets wipe.
- Wipe **W2**: **90%** → Friend, **10%** burn.
- Holder exit ~raider **×9.2** / wins **12** so Friend held wipes land in **8–10×**.
- No 5‑min farming layer.

### Create↔raid parity — WIP

Stress: `npm run sim:parity` / `npm run sim:parity:behavior`. Raid-glut → discount entry (mul 1/0.75/0.6/0.5).

## Protocol

Create/entry/reroll/clear fees → pool while burn flag is off. Tickets are the anti early-claim share mechanism.
