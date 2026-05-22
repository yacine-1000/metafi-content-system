# Image Bank Spec — Metafi V2.5

## Banks

Three image banks exist. Each serves a distinct visual role.

| Bank | Role |
|------|------|
| **Hook Bank** | High-impact opening visuals — draws attention, sets tone |
| **Body Bank** | Supporting mid-content visuals — reinforces or contextualises |
| **App Bank** | App/product-focused visuals — user-supplied, brand-specific |

---

## Format-to-Bank Mapping

Each slide slot maps to exactly one bank. This is locked.

### POV (2 slides)
| Slide | Bank |
|-------|------|
| 1 | Hook |
| 2 | App |

### Hot Take (1 slide)
| Slide | Bank |
|-------|------|
| 1 | Hook |

### Pain Mirror (3 slides)
| Slide | Bank |
|-------|------|
| 1 | Hook |
| 2 | Body |
| 3 | App |

### Micro Story (4 slides)
| Slide | Bank |
|-------|------|
| 1 | Hook |
| 2 | Body |
| 3 | App |
| 4 | Body |

### Educational (4 slides)
| Slide | Bank |
|-------|------|
| 1 | Hook |
| 2 | Body |
| 3 | App |
| 4 | Body |

---

## Bank Folder Structure

Each bank follows the same lifecycle folder pattern:

```
assets/
  hook-bank/
    available/
    used/
  body-bank/
    available/
    used/
  app-bank/
    available/
    used/
```

---

## Image Lifecycle

1. **Pick** — select an image from `available/` for the assigned slot
2. **Use** — image is embedded into the slide at render time
3. **Move** — after use, move the image from `available/` to `used/`
4. **Recycle** — if `available/` is empty, move all images from `used/` back to `available/` and restart

This ensures no image repeats until the full bank has been cycled through.

---

## Notes

- **App Bank images are user-supplied.** They are not part of the default asset set. The user adds their own app screenshots or brand visuals to `app-bank/available/`.
- This system replaces the old fixed 5-image slot map (`hook-01.png`, `body-01.jpg`, etc.). The old map is a hardcoded placeholder — the bank system is the target.
- Bank selection logic runs before `build-assembly-config` outputs the config, so each slide's `image_path` is resolved before the renderer is invoked.
