// ruleset-schema.test.ts — the v2 structural validator (ADR 0007, M2-S1): every
// type/bound/pattern violation, duplicate id, dangling reference, cross-field rule,
// unknown-key rejection (at every nesting level), null (at every nesting level),
// canonical-default application, and the parse-text cap boundary.

import { describe, it, expect } from 'vitest';
import type { Ruleset } from '@wynding/types';
import { RulesetError } from './ruleset';
import { validateRulesetShape, parseRulesetJson, MAX_RULESET_TEXT_UNITS } from './ruleset-schema';

/** A minimal, fully valid v2 bundle — every field present, one of everything. */
function validBundle(): Ruleset {
  return {
    formatVersion: 2,
    rulesetId: 'wynding-core-m1',
    version: 1,
    creepCatalog: [
      {
        id: 'normal',
        hp: 20,
        speedFp: 26,
        armor: 0,
        domain: 'ground',
        immunities: [],
        leakCost: 1,
        bounty: 1,
      },
    ],
    towerCatalog: [
      {
        id: 'basic',
        cost: 5,
        attack: { domain: 'ground', rangeFp: 1024, cadenceTicks: 30, travelTicks: 4 },
        effects: [{ kind: 'direct', form: 'single', damage: 10 }],
      },
    ],
    balance: {
      startingLives: 10,
      startingBounty: 80,
      refundNum: 3,
      refundDen: 4,
      slowFloorNum: 1,
      slowFloorDen: 4,
      earlyCallBountyDivisor: 0,
    },
    scoring: { survivalMul: 25, starThresholds: [1, 6, 9], earlyCallScoreDivisor: 0 },
    boards: [
      {
        id: 'field-01',
        widthTiles: 9,
        heightTiles: 5,
        entrance: { col: 0, row: 2 },
        exit: { col: 8, row: 2 },
        waves: [
          {
            index: 0,
            countdownTicks: 500,
            clearBonus: 0,
            entries: [{ creepId: 'normal', count: 10, spacingTicks: 20 }],
          },
        ],
      },
    ],
  };
}

/** Deep clone via JSON so each case mutates in isolation. */
function clone(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(validBundle())) as Record<string, unknown>;
}

function rejects(mutate: (b: Record<string, unknown>) => void): void {
  const b = clone();
  mutate(b);
  expect(() => validateRulesetShape(b)).toThrow(RulesetError);
}

describe('validateRulesetShape — accepts a valid bundle', () => {
  it('returns a normalized, deep-frozen copy — not the caller object', () => {
    const b = validBundle();
    const normalized = validateRulesetShape(b);
    expect(normalized).not.toBe(b);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.creepCatalog)).toBe(true);
    expect(Object.isFrozen(normalized.creepCatalog[0])).toBe(true);
    expect(normalized.rulesetId).toBe('wynding-core-m1');
  });
});

describe('validateRulesetShape — top level', () => {
  it('rejects a non-object / null value', () => {
    expect(() => validateRulesetShape(null)).toThrow(RulesetError);
    expect(() => validateRulesetShape(42)).toThrow(RulesetError);
    expect(() => validateRulesetShape('x')).toThrow(RulesetError);
    expect(() => validateRulesetShape([])).toThrow(RulesetError);
  });

  it('rejects an unknown top-level property', () => {
    rejects((b) => (b.extra = 1));
  });

  it('rejects an unsupported formatVersion', () => {
    rejects((b) => (b.formatVersion = 1));
    rejects((b) => (b.formatVersion = 3));
  });

  it('rejects a malformed rulesetId', () => {
    rejects((b) => (b.rulesetId = 7));
    rejects((b) => (b.rulesetId = ''));
    rejects((b) => (b.rulesetId = 'Upper'));
    rejects((b) => (b.rulesetId = '1starts-with-digit'));
    rejects((b) => (b.rulesetId = 'has_underscore'));
    rejects((b) => (b.rulesetId = 'a'.repeat(33)));
  });

  it('accepts the id pattern boundary (32 chars, hyphens/digits)', () => {
    const b = clone();
    b.rulesetId = 'a' + '0'.repeat(31);
    expect(() => validateRulesetShape(b)).not.toThrow();
  });

  it('rejects a non-integer / negative version', () => {
    rejects((b) => (b.version = -1));
    rejects((b) => (b.version = 1.5));
    rejects((b) => (b.version = 'x'));
  });

  it('rejects an out-of-bounds catalog/board cardinality', () => {
    rejects((b) => (b.creepCatalog = []));
    rejects((b) => (b.towerCatalog = []));
    rejects((b) => (b.boards = []));
    rejects(
      (b) =>
        (b.creepCatalog = Array.from({ length: 65 }, (_, i) => ({
          id: `c${i}`,
          hp: 1,
          speedFp: 1,
          armor: 0,
          domain: 'ground',
          immunities: [],
          leakCost: 1,
          bounty: 0,
        }))),
    );
  });
});

describe('validateRulesetShape — null / unknown key at each nesting level', () => {
  it('rejects null at the top level and every nested container', () => {
    expect(() => validateRulesetShape(null)).toThrow(RulesetError);
    rejects((b) => (b.creepCatalog = [null]));
    rejects((b) => (b.towerCatalog = [null]));
    rejects((b) => (b.balance = null));
    rejects((b) => (b.scoring = null));
    rejects((b) => (b.boards = [null]));
    rejects((b) => {
      const boards = b.boards as Record<string, unknown>[];
      boards[0]!.waves = [null];
    });
    rejects((b) => {
      const boards = b.boards as Record<string, unknown>[];
      const waves = boards[0]!.waves as Record<string, unknown>[];
      waves[0]!.entries = [null];
    });
    rejects((b) => {
      const towers = b.towerCatalog as Record<string, unknown>[];
      towers[0]!.effects = [null];
    });
    rejects((b) => {
      const towers = b.towerCatalog as Record<string, unknown>[];
      towers[0]!.attack = null;
    });
  });

  it('rejects an unknown property in a creep def', () => {
    rejects((b) => {
      const creeps = b.creepCatalog as Record<string, unknown>[];
      creeps[0]!.extra = 1;
    });
  });

  it('rejects an unknown property in a tower def / attack / effect', () => {
    rejects((b) => {
      const towers = b.towerCatalog as Record<string, unknown>[];
      towers[0]!.extra = 1;
    });
    rejects((b) => {
      const towers = b.towerCatalog as Record<string, unknown>[];
      (towers[0]!.attack as Record<string, unknown>).extra = 1;
    });
    rejects((b) => {
      const towers = b.towerCatalog as Record<string, unknown>[];
      (towers[0]!.effects as Record<string, unknown>[])[0]!.extra = 1;
    });
  });

  it('rejects an unknown property in balance / scoring', () => {
    rejects((b) => ((b.balance as Record<string, unknown>).extra = 1));
    rejects((b) => ((b.scoring as Record<string, unknown>).extra = 1));
  });

  it('rejects an unknown property in a board / wave / wave-entry', () => {
    rejects((b) => {
      const boards = b.boards as Record<string, unknown>[];
      boards[0]!.extra = 1;
    });
    rejects((b) => {
      const boards = b.boards as Record<string, unknown>[];
      (boards[0]!.waves as Record<string, unknown>[])[0]!.extra = 1;
    });
    rejects((b) => {
      const boards = b.boards as Record<string, unknown>[];
      const waves = boards[0]!.waves as Record<string, unknown>[];
      (waves[0]!.entries as Record<string, unknown>[])[0]!.extra = 1;
    });
  });
});

describe('validateRulesetShape — creep catalog', () => {
  it('rejects a malformed id / hp / speedFp / armor / domain / leakCost / bounty', () => {
    rejects((b) => {
      (b.creepCatalog as Record<string, unknown>[])[0]!.id = 'Bad Id';
    });
    rejects((b) => ((b.creepCatalog as Record<string, unknown>[])[0]!.hp = 0));
    rejects((b) => ((b.creepCatalog as Record<string, unknown>[])[0]!.speedFp = 0));
    rejects((b) => ((b.creepCatalog as Record<string, unknown>[])[0]!.armor = -1));
    rejects((b) => ((b.creepCatalog as Record<string, unknown>[])[0]!.domain = 'plasma'));
    rejects((b) => ((b.creepCatalog as Record<string, unknown>[])[0]!.leakCost = 0));
    rejects((b) => ((b.creepCatalog as Record<string, unknown>[])[0]!.leakCost = 1001));
    rejects((b) => ((b.creepCatalog as Record<string, unknown>[])[0]!.bounty = -1));
  });

  it('rejects a duplicate creep id', () => {
    rejects((b) => {
      const creeps = b.creepCatalog as Record<string, unknown>[];
      creeps.push({ ...creeps[0]! });
    });
  });

  it('rejects more than 2 immunities, or an invalid immunity value', () => {
    rejects((b) => {
      (b.creepCatalog as Record<string, unknown>[])[0]!.immunities = ['slow', 'stun', 'slow'];
    });
    rejects((b) => {
      (b.creepCatalog as Record<string, unknown>[])[0]!.immunities = ['poison'];
    });
  });

  it('sorts immunities into canonical order (slow before stun) when authored reversed', () => {
    const b = clone();
    (b.creepCatalog as Record<string, unknown>[])[0]!.immunities = ['stun', 'slow'];
    const normalized = validateRulesetShape(b);
    expect(normalized.creepCatalog[0]!.immunities).toEqual(['slow', 'stun']);
  });

  it('dedupes a repeated immunity value (set semantics)', () => {
    const b = clone();
    (b.creepCatalog as Record<string, unknown>[])[0]!.immunities = ['slow', 'slow'];
    const normalized = validateRulesetShape(b);
    expect(normalized.creepCatalog[0]!.immunities).toEqual(['slow']);
  });

  it('rejects an invalid role, accepts the sole legal role', () => {
    rejects((b) => {
      (b.creepCatalog as Record<string, unknown>[])[0]!.role = 'minion';
    });
    const b = clone();
    (b.creepCatalog as Record<string, unknown>[])[0]!.role = 'boss';
    const normalized = validateRulesetShape(b);
    expect(normalized.creepCatalog[0]!.role).toBe('boss');
  });

  it('omits role entirely when absent (never `role: undefined`)', () => {
    const normalized = validateRulesetShape(validBundle());
    expect('role' in normalized.creepCatalog[0]!).toBe(false);
  });
});

describe('validateRulesetShape — tower catalog + effects', () => {
  it('rejects a malformed tower id / cost', () => {
    rejects((b) => {
      (b.towerCatalog as Record<string, unknown>[])[0]!.id = 'Bad Id';
    });
    rejects((b) => ((b.towerCatalog as Record<string, unknown>[])[0]!.cost = 0));
  });

  it('rejects a duplicate tower id', () => {
    rejects((b) => {
      const towers = b.towerCatalog as Record<string, unknown>[];
      towers.push({ ...towers[0]!, effects: [...(towers[0]!.effects as unknown[])] });
    });
  });

  it('rejects an out-of-bounds effects array', () => {
    rejects((b) => ((b.towerCatalog as Record<string, unknown>[])[0]!.effects = []));
    rejects((b) => {
      const towers = b.towerCatalog as Record<string, unknown>[];
      towers[0]!.effects = Array.from({ length: 9 }, () => ({
        kind: 'direct',
        form: 'single',
        damage: 1,
      }));
    });
  });

  it('rejects each effect-kind bound violation', () => {
    // direct/single, direct/aoe
    rejects((b) => {
      (b.towerCatalog as Record<string, unknown>[])[0]!.effects = [
        { kind: 'direct', form: 'single', damage: 0 },
      ];
    });
    rejects((b) => {
      (b.towerCatalog as Record<string, unknown>[])[0]!.effects = [
        { kind: 'direct', form: 'aoe', damage: 10, radiusFp: 0 },
      ];
    });
    // slow
    rejects((b) => {
      (b.towerCatalog as Record<string, unknown>[])[0]!.effects = [
        { kind: 'slow', mulFp: 256, durationTicks: 10 },
      ];
    });
    // stun
    rejects((b) => {
      (b.towerCatalog as Record<string, unknown>[])[0]!.effects = [
        { kind: 'stun', chanceNum: 0, durationTicks: 10 },
      ];
    });
    // dot: duration must be >= cadence
    rejects((b) => {
      (b.towerCatalog as Record<string, unknown>[])[0]!.effects = [
        { kind: 'dot', damagePerTick: 1, cadenceTicks: 10, durationTicks: 5 },
      ];
    });
    // support: must strengthen (> 256)
    rejects((b) => {
      const t = (b.towerCatalog as Record<string, unknown>[])[0]!;
      delete t.attack;
      t.effects = [{ kind: 'support', damageMulFp: 256 }];
    });
    // burst/single, burst/aoe
    rejects((b) => {
      const t = (b.towerCatalog as Record<string, unknown>[])[0]!;
      delete (t.attack as Record<string, unknown>).cadenceTicks;
      t.effects = [{ kind: 'burst', form: 'single', damage: 0 }];
    });
  });

  it('rejects an unknown effect kind / form', () => {
    rejects((b) => {
      (b.towerCatalog as Record<string, unknown>[])[0]!.effects = [{ kind: 'heal', amount: 1 }];
    });
    rejects((b) => {
      (b.towerCatalog as Record<string, unknown>[])[0]!.effects = [
        { kind: 'direct', form: 'diagonal', damage: 1 },
      ];
    });
  });

  it('rejects a support bundle carrying attack or a second effect', () => {
    rejects((b) => {
      const t = (b.towerCatalog as Record<string, unknown>[])[0]!;
      t.effects = [{ kind: 'support', damageMulFp: 300 }]; // still has attack — must be exclusive
    });
    rejects((b) => {
      const t = (b.towerCatalog as Record<string, unknown>[])[0]!;
      delete t.attack;
      t.effects = [
        { kind: 'support', damageMulFp: 300 },
        { kind: 'direct', form: 'single', damage: 10 },
      ];
    });
  });

  it('accepts a valid support-only bundle (no attack, exactly one effect)', () => {
    const b = clone();
    const t = (b.towerCatalog as Record<string, unknown>[])[0]!;
    delete t.attack;
    t.effects = [{ kind: 'support', damageMulFp: 300 }];
    expect(() => validateRulesetShape(b)).not.toThrow();
  });

  it('rejects a non-support bundle with no attack', () => {
    rejects((b) => {
      delete (b.towerCatalog as Record<string, unknown>[])[0]!.attack;
    });
  });

  it('rejects more than one burst effect per bundle', () => {
    rejects((b) => {
      const t = (b.towerCatalog as Record<string, unknown>[])[0]!;
      delete (t.attack as Record<string, unknown>).cadenceTicks;
      t.effects = [
        { kind: 'burst', form: 'single', damage: 10 },
        { kind: 'burst', form: 'aoe', damage: 10, radiusFp: 100 },
      ];
    });
  });

  it('rejects a burst bundle whose attack carries cadenceTicks', () => {
    rejects((b) => {
      const t = (b.towerCatalog as Record<string, unknown>[])[0]!;
      t.effects = [{ kind: 'burst', form: 'single', damage: 10 }];
      // attack.cadenceTicks still present — must be omitted for a burst bundle
    });
  });

  it('accepts a burst bundle whose attack omits cadenceTicks', () => {
    const b = clone();
    const t = (b.towerCatalog as Record<string, unknown>[])[0]!;
    delete (t.attack as Record<string, unknown>).cadenceTicks;
    t.effects = [{ kind: 'burst', form: 'single', damage: 10 }];
    expect(() => validateRulesetShape(b)).not.toThrow();
  });

  it('rejects a non-burst attacking bundle missing cadenceTicks, or travelTicks >= cadenceTicks', () => {
    rejects((b) => {
      delete ((b.towerCatalog as Record<string, unknown>[])[0]!.attack as Record<string, unknown>)
        .cadenceTicks;
    });
    rejects((b) => {
      (
        (b.towerCatalog as Record<string, unknown>[])[0]!.attack as Record<string, unknown>
      ).travelTicks = 30;
    });
  });

  it('rejects an invalid attack domain', () => {
    rejects((b) => {
      ((b.towerCatalog as Record<string, unknown>[])[0]!.attack as Record<string, unknown>).domain =
        'diagonal';
    });
  });
});

describe('validateRulesetShape — balance / scoring', () => {
  it('rejects each balance bound violation', () => {
    rejects((b) => ((b.balance as Record<string, unknown>).startingLives = 0));
    rejects((b) => ((b.balance as Record<string, unknown>).startingBounty = -1));
    rejects((b) => ((b.balance as Record<string, unknown>).refundNum = -1));
    rejects((b) => ((b.balance as Record<string, unknown>).refundDen = 0));
    rejects((b) => {
      const bal = b.balance as Record<string, unknown>;
      bal.refundNum = 5;
      bal.refundDen = 4;
    });
    rejects((b) => ((b.balance as Record<string, unknown>).slowFloorDen = 0));
    rejects((b) => {
      const bal = b.balance as Record<string, unknown>;
      bal.slowFloorNum = 5;
      bal.slowFloorDen = 4;
    });
    rejects((b) => ((b.balance as Record<string, unknown>).earlyCallBountyDivisor = -1));
  });

  it('rejects each scoring bound violation', () => {
    rejects((b) => ((b.scoring as Record<string, unknown>).survivalMul = -1));
    rejects((b) => ((b.scoring as Record<string, unknown>).starThresholds = [1, 6]));
    rejects((b) => ((b.scoring as Record<string, unknown>).starThresholds = [9, 6, 1]));
    rejects((b) => ((b.scoring as Record<string, unknown>).earlyCallScoreDivisor = -1));
  });
});

describe('validateRulesetShape — boards / waves / entries', () => {
  it('rejects a malformed board id / dims / entrance / exit', () => {
    rejects((b) => {
      (b.boards as Record<string, unknown>[])[0]!.id = 'Bad Id';
    });
    rejects((b) => ((b.boards as Record<string, unknown>[])[0]!.widthTiles = 0));
    rejects((b) => ((b.boards as Record<string, unknown>[])[0]!.heightTiles = 0));
    rejects((b) => {
      (b.boards as Record<string, unknown>[])[0]!.entrance = { col: -1, row: 2 };
    });
    rejects((b) => {
      (b.boards as Record<string, unknown>[])[0]!.exit = { col: 99, row: 2 };
    });
    rejects((b) => {
      (b.boards as Record<string, unknown>[])[0]!.entrance = { col: 0, row: 2, extra: 1 };
    });
  });

  it('rejects a duplicate board id', () => {
    rejects((b) => {
      const boards = b.boards as Record<string, unknown>[];
      boards.push({ ...boards[0]!, waves: [...(boards[0]!.waves as unknown[])] });
    });
  });

  it('rejects a wave.index that does not match its array position (non-contiguous)', () => {
    rejects((b) => {
      const boards = b.boards as Record<string, unknown>[];
      (boards[0]!.waves as Record<string, unknown>[])[0]!.index = 1;
    });
    rejects((b) => {
      const boards = b.boards as Record<string, unknown>[];
      (boards[0]!.waves as Record<string, unknown>[])[0]!.index = 1.5;
    });
  });

  it('rejects a malformed countdownTicks / clearBonus', () => {
    rejects((b) => {
      const boards = b.boards as Record<string, unknown>[];
      (boards[0]!.waves as Record<string, unknown>[])[0]!.countdownTicks = 0;
    });
    rejects((b) => {
      const boards = b.boards as Record<string, unknown>[];
      (boards[0]!.waves as Record<string, unknown>[])[0]!.clearBonus = -1;
    });
  });

  it('rejects a dangling creepId reference', () => {
    rejects((b) => {
      const boards = b.boards as Record<string, unknown>[];
      const waves = boards[0]!.waves as Record<string, unknown>[];
      (waves[0]!.entries as Record<string, unknown>[])[0]!.creepId = 'no-such-creep';
    });
  });

  it('rejects a malformed count / spacingTicks / offsetTicks', () => {
    rejects((b) => {
      const boards = b.boards as Record<string, unknown>[];
      const waves = boards[0]!.waves as Record<string, unknown>[];
      (waves[0]!.entries as Record<string, unknown>[])[0]!.count = 0;
    });
    rejects((b) => {
      const boards = b.boards as Record<string, unknown>[];
      const waves = boards[0]!.waves as Record<string, unknown>[];
      (waves[0]!.entries as Record<string, unknown>[])[0]!.spacingTicks = 0;
    });
    rejects((b) => {
      const boards = b.boards as Record<string, unknown>[];
      const waves = boards[0]!.waves as Record<string, unknown>[];
      (waves[0]!.entries as Record<string, unknown>[])[0]!.offsetTicks = -1;
    });
  });

  it('defaults offsetTicks to 0 when omitted', () => {
    const normalized = validateRulesetShape(validBundle());
    expect(normalized.boards[0]!.waves[0]!.entries[0]!.offsetTicks).toBe(0);
  });

  it('accepts an explicit offsetTicks', () => {
    const b = clone();
    const boards = b.boards as Record<string, unknown>[];
    const waves = boards[0]!.waves as Record<string, unknown>[];
    (waves[0]!.entries as Record<string, unknown>[])[0]!.offsetTicks = 5;
    const normalized = validateRulesetShape(b);
    expect(normalized.boards[0]!.waves[0]!.entries[0]!.offsetTicks).toBe(5);
  });

  it('rejects an out-of-bounds entries/waves cardinality', () => {
    rejects((b) => {
      const boards = b.boards as Record<string, unknown>[];
      (boards[0]!.waves as Record<string, unknown>[])[0]!.entries = [];
    });
    rejects((b) => {
      const boards = b.boards as Record<string, unknown>[];
      boards[0]!.waves = [];
    });
  });
});

describe('parseRulesetJson', () => {
  it('parses valid JSON text into a validated bundle', () => {
    const text = JSON.stringify(validBundle());
    const parsed = parseRulesetJson(text);
    expect(parsed.rulesetId).toBe('wynding-core-m1');
  });

  it('rejects malformed JSON text', () => {
    expect(() => parseRulesetJson('{not json')).toThrow(RulesetError);
  });

  it('rejects text that parses but fails structural validation', () => {
    expect(() => parseRulesetJson(JSON.stringify({ formatVersion: 1 }))).toThrow(RulesetError);
  });

  it('accepts text at exactly MAX_RULESET_TEXT_UNITS (ASCII), padded via whitespace', () => {
    const text = JSON.stringify(validBundle());
    expect(text.length).toBeLessThan(MAX_RULESET_TEXT_UNITS);
    const padded = ' '.repeat(MAX_RULESET_TEXT_UNITS - text.length) + text;
    expect(padded.length).toBe(MAX_RULESET_TEXT_UNITS);
    expect(() => parseRulesetJson(padded)).not.toThrow();
  });

  it('rejects text one UTF-16 code unit beyond the cap (ASCII)', () => {
    const text = JSON.stringify(validBundle());
    const padded = ' '.repeat(MAX_RULESET_TEXT_UNITS + 1 - text.length) + text;
    expect(padded.length).toBe(MAX_RULESET_TEXT_UNITS + 1);
    expect(() => parseRulesetJson(padded)).toThrow(RulesetError);
  });

  it('counts a surrogate pair as 2 UTF-16 code units, not 1 codepoint', () => {
    // A multibyte (astral) character embedded in a JSON string is 2 UTF-16 code
    // units — the cap must be counted via `.length` (code units), not codepoints.
    const text = JSON.stringify(validBundle());
    const emoji = '\u{1F600}'; // 😀 — a single codepoint, 2 UTF-16 code units
    expect(emoji.length).toBe(2);
    // Pad to EXACTLY the cap regardless of the fixture's serialized parity (a space
    // absorbs an odd gap; `repeat` truncates fractions, so parity must be handled
    // explicitly or an unrelated fixture edit silently shifts the boundary), with
    // surrogate pairs proving the cap counts code units, not codepoints or bytes.
    const gap = MAX_RULESET_TEXT_UNITS - text.length;
    const atCap = text + ' '.repeat(gap % 2) + emoji.repeat(Math.floor(gap / 2));
    // The trailing emoji repeats make the JSON invalid, but the LENGTH check runs
    // BEFORE JSON.parse — so exactly-at-cap still reaches (and fails at) parse,
    // while one-past-cap is rejected by the length guard before parse ever runs.
    expect(atCap.length).toBe(MAX_RULESET_TEXT_UNITS);
    expect(() => parseRulesetJson(atCap)).toThrow(RulesetError); // fails to parse (trailing junk)
    const overCap = atCap + emoji;
    expect(overCap.length).toBe(MAX_RULESET_TEXT_UNITS + 2);
    expect(() => parseRulesetJson(overCap)).toThrow(RulesetError); // rejected by the length cap
  });
});
