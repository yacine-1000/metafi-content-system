# Generation Architecture V2.5 — Metafi

## Current Pipeline (V2)

```
raw-intake  →  planning  →  hook  →  body  →  final-slide  →  caption  →  strategy-check  →  build-assembly-config  →  assemble-slider  →  save/upload
```

---

## Target Pipeline (V2.5)

```
raw-intake  →  planning  →  script-composer  →  caption  →  strategy-check  →  build-assembly-config  →  assemble-slider  →  save/upload
```

---

## Why Hook / Body / Final-Slide Is Too Rigid

The current three-phase split (`hook`, `body`, `final-slide`) hardcodes a 5-slide structure:
- 1 hook slide
- 3 body slides (enforced by schema and validation)
- 1 final slide

This makes it impossible to generate formats with different slide counts without breaking the pipeline. The `body` phase asserts `body_slides.length === 3` and exits on failure. The `build-assembly-config` `IMAGE_PATHS` map only covers keys 1–5 in a fixed role order. There is no mechanism to express a 1-slide Hot Take or a 2-slide POV.

---

## Why Script-Composer Is Needed

`script-composer` replaces `hook` + `body` + `final-slide` with a single phase that:

- Receives the chosen format from `planning`
- Knows the exact slide count for that format (1–4)
- Outputs a `slides` array where each item has a `slide_number`, `role`, and `text`
- Works for all five formats without branching logic in the pipeline

The format determines slide count. Script-composer does not guess — it receives the format as an input field and constructs the script accordingly.

---

## Variable Slide Count Support

`script-composer` must support slide counts 1 through 4:

| Format | Slides |
|--------|--------|
| Hot Take | 1 |
| POV | 2 |
| Pain Mirror | 3 |
| Micro Story | 4 |
| Educational | 4 |

The output schema for `script-composer` is a `slides` array. Length is validated against the format's locked count.

---

## Assembly Layer — What Changes and What Doesn't

**`assemble-slider.js` — no structural changes needed.**
It already iterates `config.slides` generically. It renders whatever slides it receives. It is format-agnostic today.

**`build-assembly-config.js` — must be updated.**
Currently hardcoded to 5 slots with a fixed `IMAGE_PATHS` map. Needs to:
1. Accept variable slide counts from `script-composer` output
2. Remove the `body_slides.length === 3` assertion
3. Resolve `image_path` per slide by querying the correct bank (Hook / Body / App) based on the format-to-bank mapping in `image-bank-spec.md`
4. Output a `slides` array of any length (1–4)

---

## Visual Bank Selection Timing

Bank selection happens inside `build-assembly-config`, before writing `assembly-config.json`. By the time `assemble-slider` runs, every slide already has a resolved `image_path`. The renderer never needs to know which bank was used.

---

## Phase I/O Summary (V2.5 Target)

| Phase | Key Inputs | Key Outputs |
|-------|-----------|-------------|
| raw-intake | raw user input | `cleanedSourceBrief.json` |
| planning | cleaned brief | `sliderPlan.json` (includes `format`) |
| script-composer | plan + format | `script.json` (`slides[]` with role + text) |
| caption | script | `captionOutput.json` |
| strategy-check | all above | `strategyCheck.json` |
| build-assembly-config | script + bank selection | `assembly-config.json` |
| assemble-slider | assembly config | `slide-N.png` renders |
| save/upload | renders + caption | post saved, uploaded |
