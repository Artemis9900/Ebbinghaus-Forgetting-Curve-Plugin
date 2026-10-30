# dsh-ebbinghaus — Plugin Manual

## Plugin overview

This plugin gives an AI a long-term memory mechanism based on the Ebbinghaus forgetting curve. Every memory carries two metrics: **strength** and **retrievability**.

- **Strength `S`** grows with each review; a new memory starts at `S = 1 + importance`.
- **Retrievability `R`** decays with idle time as `exp(-Δt/S)`.
- Search results are ranked by **retrievability × importance**, and a memory that gets retrieved or explicitly reviewed has its lifespan extended.
- When a memory has gone unused for a long time, is unimportant, and has never been reviewed (`R < 0.12`, `importance ≤ 2`, `review_count = 0`), it is **archived** instead of piling up forever.

The plugin exposes five tools — `ebb_add` (remember), `ebb_search` (retrieve), `ebb_review` (review), `ebb_stats` (statistics), `ebb_sweep` (forgetting sweep). A background sweep runs every 6 hours. Everything runs on local SQLite: **no model calls, no vector database, no external service — zero token cost and fully offline.**

## 1. Parameters

| Parameter | Default | Meaning |
|---|---|---|
| `dbPath` | `~/.dsh-ebbinghaus/memory.db` | SQLite file location |
| `sweepHours` | `6` | Interval of the automatic forgetting sweep, in hours. Set to `0` to disable automatic archiving entirely |
| `archiveR` | `0.12` | Archive threshold. Below this retrievability a memory becomes an archive candidate. Larger = more forgetful, smaller = more nostalgic |
| `archiveImportance` | `2` | Archive rule. A memory can be archived only if its importance is ≤ this value |
| `curve` | `exponential` | Forgetting-curve shape; four other functions are available |
| `curveK` | `1.5` | Shape parameter: exponent for `power`, coefficient for `logarithmic`, steepness for `gaussian` |

**All three archive conditions must hold at the same time:**

```
retrievability R < archiveR  AND  importance ≤ archiveImportance  AND  review_count = 0
```

In other words: important memories are never archived, reviewed memories are never archived, and only memories that are "long unused and don't matter" sink out of the way.

## 2. Tools

| Tool | Description |
|---|---|
| `ebb_add` | Remember one item. Parameters: `content` (required), `importance` 1–5, `tags`. Returns the new entry's id and initial strength. |
| `ebb_search` | Retrieve. Parameters: `query` (required, Chinese substrings work), `limit` 1–20, `includeArchived`. Ranked by `R × importance`; a hit extends the memory's lifespan. |
| `ebb_review` | Review. Parameters: `id` (required), `quality` 1–5. Strength grows per the formula below. |
| `ebb_stats` | Overview: total, active, archived, average retrievability, how many are fading, and the active curve. |
| `ebb_sweep` | Run a forgetting sweep immediately, archiving whatever qualifies. |

## 3. Forgetting-curve functions and the core formulas

Choose the shape with `curve`; choose the shape parameter with `curveK` (default `1.5`).

### 1. `exponential` — classic exponential forgetting curve

- Formula: `R = e^(-x)`
- Character: drops fast early, then approaches 0 asymptotically. Closest to the textbook Ebbinghaus curve.
- Best for: scenarios where you want the library to stay lean — "forget it when it deserves to be forgotten". **This is the default.**

### 2. `power` — power-law forgetting curve

- Formula: `R = (1 + x)^(-k)`
- Character: slightly slower than exponential early on, with a very long tail that never truly reaches zero.
- Best for: wanting to "still recall old things in rough outline".

### 3. `hyperbolic` — hyperbolic forgetting curve

- Formula: `R = 1 / (1 + x)`
- Character: the most nostalgic option; even after a year there is residual retrievability.
- Best for: long-term companion characters that need to remember things from a long time ago.

### 4. `logarithmic` — logarithmic forgetting curve

- Formula: `R = 1 / (1 + k · ln(1 + x))`
- Character: the slowest early decay, almost like "permanent memory".
- Best for: storing only a handful of long-lived facts (birthdays, forms of address, important agreements).
- **Warning:** with the default threshold `0.12` this effectively never archives. You must raise `archiveR` at the same time.

### 5. `gaussian` — Gaussian forgetting curve

- Formula: `R = e^(-x² / 2k)`
- Character: flat at first, as if nothing is being forgotten, then falls off a cliff past a certain point — like a hard expiry.
- Best for: conversation caches and short-lived task notes that *should* disappear once they expire.

### Retrievability `R` at the same `x` (k = 1.5)

```
x (days / strength)     0     0.5      1      2      4      8
exponential         1.000   0.607  0.368  0.135  0.018  0.000
power               1.000   0.544  0.354  0.192  0.089  0.037
hyperbolic          1.000   0.667  0.500  0.333  0.200  0.111
logarithmic         1.000   0.622  0.490  0.378  0.293  0.233
gaussian            1.000   0.920  0.717  0.264  0.005  0.000
```

### How many `x` units until `R` falls below the default archive threshold `R = 0.12`

```
exponential  2.14
gaussian     2.54
power        3.12
hyperbolic   7.34
logarithmic  131.82
```

### Converted into calendar days (`days = x × strength`, `strength = 1 + importance`), assuming no review at all

```
curve           imp.1    imp.2    imp.3    imp.4    imp.5
exponential      4 d      6 d      9 d     11 d     13 d
gaussian         5 d      8 d     10 d     13 d     15 d
power            6 d      9 d     12 d     16 d     19 d
hyperbolic      15 d     22 d     29 d     37 d     44 d
logarithmic    264 d    395 d    527 d    659 d    791 d
```

> Note: these are the *fastest possible* archive times, for memories never retrieved and never reviewed. In practice, a single `ebb_search` hit or one `ebb_review` increases the strength and pushes archiving significantly further out.

### Core formulas

```
R = curve(x)                    x = idle days / strength S      retrievability decays over time
S ← S × 1.8 × f(quality) + 0.5                                  each review makes a memory more durable
initial strength S0 = 1 + importance
```

Intuition for `x`: a memory with `S = 4` left idle for 8 days gives `x = 2`; a memory with `S = 16` left idle for the same 8 days gives `x = 0.5`. **The larger the strength, the slower the decay for the same calendar time.**

## 4. Concepts and how to adjust them

### 1. Initial strength `S0 = 1 + importance`

- **Effect:** determines how durable a new memory is from the start. Importance 5 is three times as durable as importance 1.
- **Adjust at call time:** `ebb_add`'s `importance` parameter (1–5, default 3).

```
importance 1 → S0 = 2      importance 3 → S0 = 4      importance 5 → S0 = 6
```

- **Adjust globally (code):** change the constant in `lib/index.js` — `const strength = 1 + importance` — for example to `2 + importance * 2`. Redeploy and restart DSH afterwards.

### 2. Review gain `S ← S × 1.8 × f(quality) + 0.5`

- **Effect:** how much a single review increases strength. The larger the `1.8`, the longer one review lasts.
- **Current behaviour:** with `quality = 4` roughly `×1.44` plus `0.5`; with `quality = 5` roughly `×1.62` plus `0.5`. Measured: `S` went from `5.00 → 16.70` at `quality = 5`.
- **Adjust at call time:** `ebb_review`'s `quality` parameter (1–5).
- **Adjust the multiplier (code):** the `1.8` in `lib/index.js` (and the `+0.5` offset).

### 3. Quality coefficient `f(quality) = 0.8 + 0.2 × quality`

- **Effect:** converts "how confident was this review" into a multiplier.

```
quality 1 → f = 1.0  (barely recalled, smallest gain)
quality 3 → f = 1.4
quality 5 → f = 1.8  (fully confident, largest gain)
```

- **Adjust at call time:** `ebb_review`'s `quality` parameter. No code change needed.
- **Adjust the mapping (code):** `const factor = 0.8 + q * 0.2` in `lib/index.js`.

### 4. Strength floor `S ≥ 0.5`

- **Effect:** prevents strength from being computed as a tiny value (or a legacy dirty row of 0) and making `R` collapse to zero instantly. Every memory's effective strength is at least `0.5`.
- **Adjust (code):** the `0.5` in `Math.max(0.5, Number(row.strength ?? 1))` in `lib/index.js`.
  - Larger → slower decay, harder to archive
  - Smaller → steeper decay

### 5. Search ranking `score = R × importance`

- **Effect:** the ordering used by `ebb_search`. It first considers "how much is still remembered right now", then multiplies by importance, so entries that are both remembered and important come first. Every hit also auto-extends the memory (`use_count + 1`, `last_used_at` refreshed) — being retrieved is itself a weak review (it does not change strength).
- **Adjust at call time:** `ebb_search`'s `limit` (1–20, default 5) and `includeArchived` (default `false`, meaning archived entries are not searchable).
- **Adjust the weighting (code):** in `lib/index.js`,
  `.map((r) => ({ ...r, score: r.R * (Number(r.importance) || 3) }))`:

```js
r.R                                  // rank by retrievability only
r.R * Math.pow(r.importance, 2)      // weight importance much more
r.R * (1 + r.importance * 0.1)       // importance as a slight modifier
```

## 5. Common pitfalls

- **UTF-8 BOM in `package.json`.** Writing it with PowerShell 5.1's `Set-Content -Encoding UTF8` adds a BOM, and DSH's `JSON.parse` then crashes during startup. To write JSON, use:

```powershell
[System.IO.File]::WriteAllText($p, $json, (New-Object System.Text.UTF8Encoding($false)))
```

- **`dsh plugin add/remove` rewrites the profile's bundle list.** It may drop entries that were added by hand. After changing the list, verify that `dsh.profile.bundles` is complete.
- **Editing the source without redeploying.** If you change the source but forget to copy it into the runtime `node_modules` directory, nothing changes after restart.

## How to install

1. Extract `dsh-ebbinghaus-0.2.0.zip`.
2. Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

3. Fully quit DeepSeek Harness and start it again.
4. Verify by calling `ebb_stats` — it should report the active curve, e.g. `curve: exponential (k=1.5)`.
