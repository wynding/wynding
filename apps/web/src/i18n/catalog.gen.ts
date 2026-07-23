// AUTO-GENERATED from i18n/en.json by scripts/i18n-gen.mjs — do not edit by hand.
// Run `pnpm run i18n:gen` to regenerate; `pnpm run i18n:check` fails if this drifts.
/* eslint-disable */
export const EN = {
  "app.title": "Wynding",
  "board.aria": "Game board. Use arrow keys to move the build cursor, Enter to build or select a tower.",
  "hud.lives": "Lives: {count}",
  "hud.bounty": "Gold: {count}",
  "hud.score": "Score: {count}",
  "hud.countdown": "Wave in {seconds}s",
  "hud.label": "Game status",
  "hud.wave.active": "Wave in progress",
  "hud.stars": "Stars: {count} of 3",
  "controls.pause": "Pause",
  "controls.resume": "Resume",
  "controls.speed": "Speed: {factor}x",
  "controls.callWave": "Call wave now",
  "controls.sell": "Sell tower (refund {refund})",
  "controls.playAgain": "Play again",
  "controls.verify": "Verify this run",
  "controls.settings": "Accessibility settings",
  "settings.title": "Accessibility",
  "settings.colourMode": "Colour vision mode",
  "settings.colourMode.default": "Default",
  "settings.colourMode.protan": "Protanopia",
  "settings.colourMode.deutan": "Deuteranopia",
  "settings.colourMode.tritan": "Tritanopia",
  "settings.reducedMotion": "Reduce motion",
  "settings.rebind": "Rebind {action}",
  "settings.rebind.prompt": "Press a key for {action}",
  "settings.unbound": "Unbound",
  "action.up": "Move up",
  "action.down": "Move down",
  "action.left": "Move left",
  "action.right": "Move right",
  "action.confirm": "Build or select",
  "action.sell": "Sell",
  "action.callWave": "Call wave",
  "action.pause": "Pause",
  "action.speed": "Cycle speed",
  "results.won": "You held the line!",
  "results.lost": "The wynd broke through.",
  "results.summary": "Score {score} — {stars} of 3 stars",
  "verify.ok": "Verified: replay re-simulated to the same score.",
  "verify.mismatch": "Verification mismatch: the replay re-simulated to a different score.",
  "verify.fail": "Verification failed: {reason}",
} as const;

export type MessageKey = keyof typeof EN;

export interface MessageParams {
  "app.title": Record<never, never>;
  "board.aria": Record<never, never>;
  "hud.lives": { "count": string | number };
  "hud.bounty": { "count": string | number };
  "hud.score": { "count": string | number };
  "hud.countdown": { "seconds": string | number };
  "hud.label": Record<never, never>;
  "hud.wave.active": Record<never, never>;
  "hud.stars": { "count": string | number };
  "controls.pause": Record<never, never>;
  "controls.resume": Record<never, never>;
  "controls.speed": { "factor": string | number };
  "controls.callWave": Record<never, never>;
  "controls.sell": { "refund": string | number };
  "controls.playAgain": Record<never, never>;
  "controls.verify": Record<never, never>;
  "controls.settings": Record<never, never>;
  "settings.title": Record<never, never>;
  "settings.colourMode": Record<never, never>;
  "settings.colourMode.default": Record<never, never>;
  "settings.colourMode.protan": Record<never, never>;
  "settings.colourMode.deutan": Record<never, never>;
  "settings.colourMode.tritan": Record<never, never>;
  "settings.reducedMotion": Record<never, never>;
  "settings.rebind": { "action": string | number };
  "settings.rebind.prompt": { "action": string | number };
  "settings.unbound": Record<never, never>;
  "action.up": Record<never, never>;
  "action.down": Record<never, never>;
  "action.left": Record<never, never>;
  "action.right": Record<never, never>;
  "action.confirm": Record<never, never>;
  "action.sell": Record<never, never>;
  "action.callWave": Record<never, never>;
  "action.pause": Record<never, never>;
  "action.speed": Record<never, never>;
  "results.won": Record<never, never>;
  "results.lost": Record<never, never>;
  "results.summary": { "score": string | number; "stars": string | number };
  "verify.ok": Record<never, never>;
  "verify.mismatch": Record<never, never>;
  "verify.fail": { "reason": string | number };
}
