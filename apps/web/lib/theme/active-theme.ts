/**
 * active-theme — the resolved ThemeContract this company wears.
 * Written by provisioning (_step_substrate_install): an approved mood
 * board's derived theme wins, else the CMO's authored ThemeContract
 * (company-theme-authoring-001 / visual phase 3b). Do NOT hand-edit.
 */
import type { ThemeContract } from "./contract";

export const activeTheme: ThemeContract = {
  "type": {
    "fontBody": "system-sans",
    "fontHeading": "source-serif"
  },
  "color": {
    "bg": "#ffffff",
    "text": "#1a2332",
    "accent": "#1e3a5f",
    "border": "#dde2ea",
    "danger": "#a32d2d",
    "success": "#1f6b45",
    "surface": "#f6f7f9",
    "textMuted": "#566074",
    "accentText": "#ffffff",
    "surfaceAlt": "#eef1f5",
    "borderStrong": "#c2cad6"
  },
  "shape": {
    "radius": 4
  }
};
