// AUTO-GENERATED from i18n/en.json by scripts/i18n-gen.mjs — do not edit by hand.
// Run `pnpm run i18n:gen` to regenerate; `pnpm run i18n:check` fails if this drifts.
/* eslint-disable */
export const EN = {
  "app.title": "Wynding",
  "app.home": "Wynding — home",
  "board.aria": "Game board. Arm a tower from the tower rail or its hotkey, then place it: with a mouse, click a cell; by touch, press to show the offset ghost, drag to adjust, then release; or with the keyboard, move the cursor with {move} and press {confirm}. Press {sell} to sell the selected tower.",
  "hud.lives": "Lives: {count}",
  "hud.bounty": "Bounty: {count}",
  "hud.score": "Score: {count}",
  "hud.countdown": "Wave in {seconds}s",
  "hud.label": "Game status",
  "hud.wave.compact.countdown": "{s}s",
  "hud.stars": "Stars: {count} of 3",
  "hud.preview.title": "Wave {waveNumber} of {waveCount}",
  "hud.preview.entry": "{count} × {name} — {domain}, {armor}, {immunities}",
  "hud.preview.domain.ground": "ground",
  "hud.preview.domain.air": "air",
  "hud.preview.armor": "armor {armor}",
  "hud.preview.immunities.none": "no immunities",
  "hud.preview.immunity.slow": "slow",
  "hud.preview.immunity.stun": "stun",
  "hud.preview.lastWave": "Final wave launched — no more waves to call",
  "creep.normal.name": "Creep",
  "creep.fast.name": "Fast Creep",
  "creep.swarm.name": "Swarm Creep",
  "creep.armored.name": "Armored Creep",
  "creep.unknown.name": "Unknown creep ({id})",
  "controls.pause": "Pause",
  "controls.resume": "Resume",
  "controls.speed": "Speed: {factor}x",
  "controls.start": "Start",
  "controls.callWave": "Call wave",
  "controls.callWave.pending": "Launching…",
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
  "action.start": "Start / Call wave",
  "action.pause": "Pause",
  "action.speed": "Cycle speed",
  "action.armTower1": "Arm tower 1",
  "action.armTower2": "Arm tower 2",
  "action.armTower3": "Arm tower 3",
  "action.armTower4": "Arm tower 4",
  "action.armTower5": "Arm tower 5",
  "action.armTower6": "Arm tower 6",
  "action.armTower7": "Arm tower 7",
  "action.armTower8": "Arm tower 8",
  "action.armTower9": "Arm tower 9",
  "results.won": "You held the line!",
  "results.lost": "The creeps broke through.",
  "results.summary": "Score {score} — {stars} of 3 stars",
  "verify.ok": "Verified: replay re-simulated to the same outcome.",
  "verify.mismatch": "Verification mismatch: the replay re-simulated to a different outcome.",
  "verify.fail": "Verification failed: {reason}",
  "tower.basic.name": "Basic Tower",
  "tower.slow.name": "Slow Tower",
  "tower.splash.name": "Splash Tower",
  "tower.venom.name": "Venom Tower",
  "tower.unknown.name": "Unknown tower ({id})",
  "tower.targets.ground": "Ground",
  "panel.cost": "Cost: {cost}",
  "panel.damage": "Damage: {damage}",
  "panel.range": "Range: {tiles} tiles",
  "panel.fireRate": "Fire rate: {rate}/s",
  "panel.targets": "Targets: {targets}",
  "panel.blastRadius": "Blast radius: {tiles} tiles",
  "panel.dot": "Poison: {damage}/tick every {cadence}s for {duration}s",
  "panel.close": "Close panel",
  "panel.sell": "Sell (refund {refund})",
  "panel.upgrade": "Max level",
  "panel.upgrade.desc": "This tower has no further upgrades in this build.",
  "live.started": "Run started. The primary button now calls the current wave early.",
  "live.armed": "{name} armed. Place it on the board.",
  "live.disarmed": "Placement cancelled.",
  "live.placed": "{name} placed.",
  "live.rejected.bounty": "Not enough Bounty.",
  "live.rejected.occupied": "That cell is already occupied.",
  "live.rejected.generic": "Can't build there.",
  "live.rejected.pendingCap": "Too many pending actions.",
  "live.sold": "Tower sold. Refunded {refund} Bounty.",
  "leave.title": "Leave this run?",
  "leave.body": "Leaving now discards this run — your towers and progress will not be kept.",
  "leave.confirm": "Leave the run",
  "leave.stay": "Stay",
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
  "app.home": Record<never, never>;
  "board.aria": { "move": string | number; "confirm": string | number; "sell": string | number };
  "hud.lives": { "count": string | number };
  "hud.bounty": { "count": string | number };
  "hud.score": { "count": string | number };
  "hud.countdown": { "seconds": string | number };
  "hud.label": Record<never, never>;
  "hud.wave.compact.countdown": { "s": string | number };
  "hud.stars": { "count": string | number };
  "hud.preview.title": { "waveNumber": string | number; "waveCount": string | number };
  "hud.preview.entry": { "count": string | number; "name": string | number; "domain": string | number; "armor": string | number; "immunities": string | number };
  "hud.preview.domain.ground": Record<never, never>;
  "hud.preview.domain.air": Record<never, never>;
  "hud.preview.armor": { "armor": string | number };
  "hud.preview.immunities.none": Record<never, never>;
  "hud.preview.immunity.slow": Record<never, never>;
  "hud.preview.immunity.stun": Record<never, never>;
  "hud.preview.lastWave": Record<never, never>;
  "creep.normal.name": Record<never, never>;
  "creep.fast.name": Record<never, never>;
  "creep.swarm.name": Record<never, never>;
  "creep.armored.name": Record<never, never>;
  "creep.unknown.name": { "id": string | number };
  "controls.pause": Record<never, never>;
  "controls.resume": Record<never, never>;
  "controls.speed": { "factor": string | number };
  "controls.start": Record<never, never>;
  "controls.callWave": Record<never, never>;
  "controls.callWave.pending": Record<never, never>;
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
  "action.armTower2": Record<never, never>;
  "action.armTower3": Record<never, never>;
  "action.armTower4": Record<never, never>;
  "action.armTower5": Record<never, never>;
  "action.armTower6": Record<never, never>;
  "action.armTower7": Record<never, never>;
  "action.armTower8": Record<never, never>;
  "action.armTower9": Record<never, never>;
  "results.won": Record<never, never>;
  "results.lost": Record<never, never>;
  "results.summary": { "score": string | number; "stars": string | number };
  "verify.ok": Record<never, never>;
  "verify.mismatch": Record<never, never>;
  "verify.fail": { "reason": string | number };
  "tower.basic.name": Record<never, never>;
  "tower.slow.name": Record<never, never>;
  "tower.splash.name": Record<never, never>;
  "tower.venom.name": Record<never, never>;
  "tower.unknown.name": { "id": string | number };
  "tower.targets.ground": Record<never, never>;
  "panel.cost": { "cost": string | number };
  "panel.damage": { "damage": string | number };
  "panel.range": { "tiles": string | number };
  "panel.fireRate": { "rate": string | number };
  "panel.targets": { "targets": string | number };
  "panel.blastRadius": { "tiles": string | number };
  "panel.dot": { "damage": string | number; "cadence": string | number; "duration": string | number };
  "panel.close": Record<never, never>;
  "panel.sell": { "refund": string | number };
  "panel.upgrade": Record<never, never>;
  "panel.upgrade.desc": Record<never, never>;
  "live.started": Record<never, never>;
  "live.armed": { "name": string | number };
  "live.disarmed": Record<never, never>;
  "live.placed": { "name": string | number };
  "live.rejected.bounty": Record<never, never>;
  "live.rejected.occupied": Record<never, never>;
  "live.rejected.generic": Record<never, never>;
  "live.rejected.pendingCap": Record<never, never>;
  "live.sold": { "refund": string | number };
  "leave.title": Record<never, never>;
  "leave.body": Record<never, never>;
  "leave.confirm": Record<never, never>;
  "leave.stay": Record<never, never>;
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
