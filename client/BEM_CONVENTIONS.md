# BEM Naming Conventions (client)

Established by F-098 (2026-07-16). All CSS class names under `client/src` follow
BEM with **kebab-case in every segment** — block, element, and modifier alike.

## The rule

```
block__element--modifier
```

- **Block**: kebab-case, prefixed `km-` (e.g. `km-review`, `km-upload-viewer`).
- **Element**: kebab-case after `__` (e.g. `__tile-icon`, `__saved-uploads-truncated`).
- **Modifier**: kebab-case after `--` (e.g. `--dragging`, `--active`).

No camelCase anywhere in a class name.

```css
/* Right */
.km-today__tile-icon { … }
.km-upload-viewer__page-drag--dragging { … }

/* Wrong — camelCase element */
.km-today__tileIcon { … }
```

## What this rule does NOT cover

- `data-tour="…"` attribute values — tour anchors for driver.js, not CSS classes
  (they happen to be kebab-case already; keep them that way).
- Third-party classes (`driver-*`, etc.) — owned by their libraries.
- State/utility classes (`is-active`, `focusring`, `km-tone--accent`) — follow
  their existing patterns.

## Why kebab-case

It dominated the older pages (Settings, Hanja, Resources) and matches standard
CSS convention. The camelCase drift (Today, Review, Chat) was mechanically
renamed to kebab-case in F-098 — 151 distinct element tokens across 38 files.

## Renaming a class

CSS classes fail silently: a class renamed in CSS but not in TSX (or vice
versa) simply stops styling with no error. When renaming, change the CSS rule,
every `className` usage (including template literals and conditional
construction), and any test that pins the class string — in the same commit.
