// domain.ts — the shared creep-domain resolver (M2-S7). Pulled out of `combat.ts`
// into its own leaf module so `tower.ts` can use the SAME totality rail without
// creating a `tower.ts` <-> `combat.ts` import cycle (`combat.ts` already imports
// `forEachValidTower` from `tower.ts`). Deliberately depends on nothing but a
// minimal structural lookup shape — not `ruleset.ts`'s `CompiledCreep` — so this
// module stays a true leaf; `CompiledCreep` (which carries `domain`) is assignable
// to `CreepDomainLookup` with no cast at every call site.

/** The one field domain resolution needs from a compiled creep — structural (not
 *  the full `CompiledCreep`), mirroring `tower.ts`'s `TowerCostLookup` precedent so
 *  this module needs no import from `ruleset.ts`. */
export interface CreepDomainLookup {
  readonly domain: 'ground' | 'air';
}

/**
 * THE single domain resolver (M2-S7 P3 — Codex/risk-log: "four hand-copied
 * `?? 'ground'` fallbacks is how totality rails drift apart"), used at every
 * domain-lookup site: `LiveCreep` construction (targeting), the movement phase's
 * `advanceCreep` call site, impact resolution (`runCombat`'s targeted-impact
 * re-check), blast membership (`blastMembers`), and placement (`canPlaceTower`'s
 * clauses 3 and 5, M2-S7 P4). Mirrors `applyImpactToCreep`'s armor precedent
 * (`creepById[creeps.creepId[idx]]`, `def?.armor ?? 0`): a `creepId` that is not a
 * string, or does not resolve in `creepById`, is TOTAL — it falls back to
 * `ground`, never throws, exactly like every other lookup in this file.
 */
export function resolveCreepDomain(
  creepById: Readonly<Partial<Record<string, CreepDomainLookup>>>,
  creepId: unknown,
): 'ground' | 'air' {
  const def = typeof creepId === 'string' ? creepById[creepId] : undefined;
  return def?.domain ?? 'ground';
}
