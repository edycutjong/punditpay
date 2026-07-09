/**
 * The scripted match — deterministic seed data engineered so one demo run
 * shows every beat that matters:
 *
 *   · below-threshold moments the agent correctly declines (judgment, not a hosepipe)
 *   · four autonomous tips + one pay-per-pick purchase (x402 both ways)
 *   · the hero beat: @vantage calls the winner at 74', it lands at 90+2',
 *     confidence 82% > the 70% rule → the agent tips without being asked
 *   · the guardrail beat: a final tip attempt would cross the 1.00 USD₮ session
 *     cap → PolicyViolationError, blocked live, logged in red
 *
 * Teams and creators are fictional. Every run of the feed is identical.
 */

export const MATCH = Object.freeze({
  id: 'final-astora-meridia-2026',
  title: 'Cup Final — Astora FC vs Meridia United',
  kickoff: '2026-07-14T19:00:00Z',
  venue: 'Estadio del Lago',
});

/** Creator directory: the humans the agent can pay. */
export const CREATORS = Object.freeze({
  '@vantage': { handle: '@vantage', role: 'live commentator', seasonHitRate: 0.78, tipJarPath: '/tip/@vantage' },
  '@tacticsroom': { handle: '@tacticsroom', role: 'tactics analyst', seasonHitRate: 0.66, tipJarPath: '/tip/@tacticsroom' },
  '@banterfc': { handle: '@banterfc', role: 'banter merchant', seasonHitRate: 0.31, tipJarPath: '/tip/@banterfc' },
});

/**
 * The timeline the agent watches. Fields consumed by the decision engine:
 * minute, significance (low|medium|high), tippable, calledIt, callMinute,
 * creatorHitRate, suggestedTip. `expect` documents the engineered outcome the
 * demo (and tests) assert — with a 70% threshold and a 1.00 USD₮ session cap.
 */
export function loadMatchFeed() {
  return [
    {
      seq: 1, minute: 1, type: 'kickoff', creator: null, tippable: false, significance: 'low',
      headline: 'Kickoff at Estadio del Lago',
      text: "1' — We're underway. Astora in claret, Meridia in white. @vantage on the call.",
      expect: 'no-action',
    },
    {
      seq: 2, minute: 12, type: 'commentary', creator: '@vantage', tippable: true, significance: 'low',
      creatorHitRate: 0.78, headline: 'Nice early read on the press',
      text: "12' — @vantage: “Meridia's press is a decoy — watch the far-side fullback.”",
      expect: 'decline-below-threshold', // 20+0+12 = 32% < 70
    },
    {
      seq: 3, minute: 23, type: 'goal', creator: '@vantage', tippable: true, significance: 'high',
      calledIt: true, callMinute: 21, creatorHitRate: 0.78, suggestedTip: '0.15',
      headline: 'Astora 1–0 — and @vantage called the corner routine',
      text: "23' — GOAL, Astora! Near-post flick from the corner — exactly the routine @vantage flagged two minutes ago.",
      expect: 'tip', // 20+24+30+2+12 = 88% > 70 → 0.15
    },
    {
      seq: 4, minute: 35, type: 'commentary', creator: '@banterfc', tippable: true, significance: 'medium',
      creatorHitRate: 0.31, headline: 'Decent gag about the keeper',
      text: "35' — @banterfc: “That keeper's come further off his line than my dad at a buffet.”",
      expect: 'decline-below-threshold', // 20+12+5 = 37% < 70
    },
    {
      seq: 5, minute: 41, type: 'goal', creator: '@tacticsroom', tippable: true, significance: 'medium',
      calledIt: true, callMinute: 38, creatorHitRate: 0.66, suggestedTip: '0.10',
      headline: 'Meridia equalize through the half-space @tacticsroom diagrammed',
      text: "41' — Meridia level, 1–1. The cutback came through the exact half-space @tacticsroom diagrammed at 38'.",
      expect: 'tip', // 20+12+30+3+11 = 76% > 70 → 0.10
    },
    {
      seq: 6, minute: 46, type: 'halftime', creator: null, tippable: false, significance: 'low',
      headline: 'Half-time: 1–1',
      text: "HT — 1–1. @tacticsroom is selling a half-time tactical read: “How Astora wins this” (x402, 0.25 USD₮).",
      pickOffer: { creator: '@tacticsroom', resource: '/pick/half-time-read', amount: '0.25' },
      expect: 'buy-pick', // user rule pre-authorizes ONE pick purchase ≤ 0.25
    },
    {
      seq: 7, minute: 58, type: 'commentary', creator: '@tacticsroom', tippable: true, significance: 'medium',
      creatorHitRate: 0.66, headline: 'Astora switch to the overload — as the paid pick said',
      text: "58' — Astora overload the left exactly as the half-time read predicted. Chance in 90 seconds.",
      expect: 'decline-below-threshold', // 20+12+11 = 43% < 70 (no fresh call)
    },
    {
      seq: 8, minute: 63, type: 'goal', creator: '@vantage', tippable: true, significance: 'high',
      calledIt: true, callMinute: 59, creatorHitRate: 0.78, suggestedTip: '0.25',
      headline: 'Astora 2–1 — the overload goal @vantage saw coming',
      text: "63' — GOAL, Astora! 2–1, born from the left overload. @vantage: “told you at 59 — the fullback was toast.”",
      expect: 'tip', // 20+24+30+4+12 = 90% > 70 → 0.25
    },
    {
      seq: 9, minute: 74, type: 'call', creator: '@vantage', tippable: false, significance: 'high',
      headline: '@vantage stakes the big call',
      text: "74' — @vantage: “Meridia will throw the kitchen sink and STILL lose to a stoppage-time counter. Book it.”",
      registersCall: { creator: '@vantage', outcome: 'stoppage-winner-astora', minute: 74 },
      expect: 'no-action',
    },
    {
      seq: 10, minute: 81, type: 'goal', creator: null, tippable: false, significance: 'high',
      headline: 'Meridia equalize — 2–2',
      text: "81' — Meridia level again, 2–2! The kitchen sink is airborne. Exactly the chaos @vantage predicted.",
      expect: 'no-action',
    },
    {
      seq: 11, minute: 92, type: 'goal', creator: '@vantage', tippable: true, significance: 'high',
      calledIt: true, callMinute: 74, creatorHitRate: 0.78, suggestedTip: '0.25',
      headline: 'ASTORA 3–2 IN STOPPAGE TIME — the exact counter @vantage booked at 74\'',
      text: "90+2' — ASTORA WIN IT ON THE COUNTER! 3–2! That is *precisely* the stoppage-time counter @vantage called at 74'. Scenes.",
      expect: 'tip-hero', // 20+24+30+10(lead cap)+12 = 96% > 70 → the hero beat
      expectNote: 'hero moment: model decides, cap still has room (0.50 spent + 0.25 pick = 0.75; +0.25 = 1.00 ≤ cap)',
    },
    {
      seq: 12, minute: 95, type: 'fulltime', creator: '@vantage', tippable: true, significance: 'medium',
      creatorHitRate: 0.78, suggestedTip: '0.25',
      calledIt: true, callMinute: 74,
      headline: 'Full-time — one more for the road?',
      text: "FT — Astora 3–2. @vantage takes a bow. The user impulse: “send him one more.”",
      expect: 'blocked-by-policy', // 1.00 spent + 0.25 > 1.00 cap → PolicyViolationError
    },
  ];
}

/** Session economics the demo asserts (with the default 70% / 1.00 cap rule). */
export const EXPECTED_SESSION = Object.freeze({
  tips: [
    { seq: 3, to: '@vantage', amount: '0.15' },
    { seq: 5, to: '@tacticsroom', amount: '0.10' },
    { seq: 8, to: '@vantage', amount: '0.25' },
    { seq: 11, to: '@vantage', amount: '0.25' },
  ],
  picks: [{ seq: 6, from: '@tacticsroom', amount: '0.25' }],
  blocked: [{ seq: 12, to: '@vantage', amount: '0.25', reason: 'would exceed session cap' }],
  totalSpent: '1.00',
  declined: [2, 4, 7],
});
