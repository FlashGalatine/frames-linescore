# Ballpark: the stock theme

A green stadium board on one browser source, 1200×260: a title, an inning header, one row per team, a total and a Ball / Strike / Out row. The board sits at the top left of the source, and the rest of the source stays transparent.

```
http://127.0.0.1:7474/frames-themes/ballpark/panels/board-1200x260.html
```

It fits up to 12 columns. Team names shrink from 28px to 14px to fit, then end in an ellipsis.

## Skins

Add `?skin=` to the URL:

| URL ending | Look |
|---|---|
| none | Green board |
| `?skin=crosley` | Red painted boards, stencil numbers on cards |
| `?skin=led` | Orange panel, red LED digits |

A skin is only CSS variables (and a line or two of overrides), so copy one to `skins/yours.css` and edit it. The variables are listed at the top of [theme.css](theme.css), and [docs/THEMING.md](../../docs/THEMING.md) covers building a theme from scratch.

Fonts come from the system, so the theme needs no network and ships nothing third-party.
