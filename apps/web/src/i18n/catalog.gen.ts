// AUTO-GENERATED from i18n/en.json by scripts/i18n-gen.mjs — do not edit by hand.
// Run `pnpm run i18n:gen` to regenerate; `pnpm run i18n:check` fails if this drifts.
/* eslint-disable */
export const EN = {
  "app.title": "Wynding",
  "board.aria": "Game board. Arm a tower from the tower rail or its hotkey, then place it: with a mouse, click a cell; by touch, press to show the offset ghost, drag to adjust, then release; or with the keyboard, move the cursor with {move} and press {confirm}. Press {sell} to sell the selected tower.",
  "hud.lives": "Lives: {count}",
  "hud.bounty": "Bounty: {count}",
  "hud.score": "Score: {count}",
  "hud.countdown": "Wave in {seconds}s",
  "hud.label": "Game status",
  "hud.wave.active": "Wave in progress",
  "hud.wave.compact.countdown": "{s}s",
  "hud.wave.compact.active": "▶",
  "hud.stars": "Stars: {count} of 3",
  "controls.pause": "Pause",
  "controls.resume": "Resume",
  "controls.speed": "Speed: {factor}x",
  "controls.start": "Start",
  "controls.playAgain": "Play again",
  "controls.verify": "Verify this run",
  "controls.settings": "Settings",
  "settings.title": "Settings",
  "settings.accessibility": "Accessibility",
  "settings.close": "Close",
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
  "action.start": "Start",
  "action.pause": "Pause",
  "action.speed": "Cycle speed",
  "action.armTower1": "Arm basic tower",
  "results.won": "You held the line!",
  "results.lost": "The creeps broke through.",
  "results.summary": "Score {score} — {stars} of 3 stars",
  "verify.ok": "Verified: replay re-simulated to the same outcome.",
  "verify.mismatch": "Verification mismatch: the replay re-simulated to a different outcome.",
  "verify.fail": "Verification failed: {reason}",
  "tower.basic.name": "Basic Tower",
  "tower.targets.ground": "Ground",
  "panel.cost": "Cost: {cost}",
  "panel.damage": "Damage: {damage}",
  "panel.range": "Range: {tiles} tiles",
  "panel.fireRate": "Fire rate: {rate}/s",
  "panel.targets": "Targets: {targets}",
  "panel.close": "Close panel",
  "panel.sell": "Sell (refund {refund})",
  "panel.upgrade": "Max level",
  "panel.upgrade.desc": "This tower has no further upgrades in this build.",
  "live.armed": "{name} armed. Place it on the board.",
  "live.disarmed": "Placement cancelled.",
  "live.placed": "{name} placed.",
  "live.rejected.bounty": "Not enough Bounty.",
  "live.rejected.occupied": "That cell is already occupied.",
  "live.rejected.generic": "Can't build there.",
  "live.rejected.pendingCap": "Too many pending actions.",
  "live.sold": "Tower sold. Refunded {refund} Bounty.",
  "rotate.title": "Rotate your device",
  "rotate.message": "Wynding plays best in landscape. Rotate your device to continue.",
  "install.banner.text": "Wynding plays best as an app — full screen, no browser bars.",
  "install.banner.install": "Install",
  "install.banner.how": "Show me how",
  "install.banner.dismiss": "Dismiss install suggestion",
  "install.ios.title": "Add Wynding to your Home Screen",
  "install.ios.body": "Tap the Share button, then choose \"Add to Home Screen\". Wynding will open full-screen, without browser bars.",
  "install.ios.close": "Close",
  "install.settings.row": "Install as app",
  "install.settings.explain": "Installing gives Wynding the whole screen. Your browser doesn't offer an install prompt — look for \"Install\" or \"Add to Home Screen\" in its menu.",
  "install.settings.declined": "Installing gives Wynding the whole screen. You can install any time from your browser's menu — look for \"Install\" or \"Add to Home Screen\".",
} as const;

export type MessageKey = keyof typeof EN;

export interface MessageParams {
  "app.title": Record<never, never>;
  "board.aria": { "move": string | number; "confirm": string | number; "sell": string | number };
  "hud.lives": { "count": string | number };
  "hud.bounty": { "count": string | number };
  "hud.score": { "count": string | number };
  "hud.countdown": { "seconds": string | number };
  "hud.label": Record<never, never>;
  "hud.wave.active": Record<never, never>;
  "hud.wave.compact.countdown": { "s": string | number };
  "hud.wave.compact.active": Record<never, never>;
  "hud.stars": { "count": string | number };
  "controls.pause": Record<never, never>;
  "controls.resume": Record<never, never>;
  "controls.speed": { "factor": string | number };
  "controls.start": Record<never, never>;
  "controls.playAgain": Record<never, never>;
  "controls.verify": Record<never, never>;
  "controls.settings": Record<never, never>;
  "settings.title": Record<never, never>;
  "settings.accessibility": Record<never, never>;
  "settings.close": Record<never, never>;
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
  "action.start": Record<never, never>;
  "action.pause": Record<never, never>;
  "action.speed": Record<never, never>;
  "action.armTower1": Record<never, never>;
  "results.won": Record<never, never>;
  "results.lost": Record<never, never>;
  "results.summary": { "score": string | number; "stars": string | number };
  "verify.ok": Record<never, never>;
  "verify.mismatch": Record<never, never>;
  "verify.fail": { "reason": string | number };
  "tower.basic.name": Record<never, never>;
  "tower.targets.ground": Record<never, never>;
  "panel.cost": { "cost": string | number };
  "panel.damage": { "damage": string | number };
  "panel.range": { "tiles": string | number };
  "panel.fireRate": { "rate": string | number };
  "panel.targets": { "targets": string | number };
  "panel.close": Record<never, never>;
  "panel.sell": { "refund": string | number };
  "panel.upgrade": Record<never, never>;
  "panel.upgrade.desc": Record<never, never>;
  "live.armed": { "name": string | number };
  "live.disarmed": Record<never, never>;
  "live.placed": { "name": string | number };
  "live.rejected.bounty": Record<never, never>;
  "live.rejected.occupied": Record<never, never>;
  "live.rejected.generic": Record<never, never>;
  "live.rejected.pendingCap": Record<never, never>;
  "live.sold": { "refund": string | number };
  "rotate.title": Record<never, never>;
  "rotate.message": Record<never, never>;
  "install.banner.text": Record<never, never>;
  "install.banner.install": Record<never, never>;
  "install.banner.how": Record<never, never>;
  "install.banner.dismiss": Record<never, never>;
  "install.ios.title": Record<never, never>;
  "install.ios.body": Record<never, never>;
  "install.ios.close": Record<never, never>;
  "install.settings.row": Record<never, never>;
  "install.settings.explain": Record<never, never>;
  "install.settings.declined": Record<never, never>;
}
