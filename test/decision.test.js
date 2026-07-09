import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMoment, scoreMoment } from '../src/core/decision.js';
import { EXPECTED_SESSION, loadMatchFeed } from '../src/core/matchfeed.js';

const RULE = { confidenceThreshold: 70, tipAmounts: { low: '0.05', medium: '0.10', high: '0.25' } };

describe('decision: scoring is deterministic', () => {
  it('identical input scores identically across 100 runs', () => {
    const moment = loadMatchFeed()[2];
    const first = scoreMoment(moment).confidence;
    for (let i = 0; i < 100; i++) assert.equal(scoreMoment(moment).confidence, first);
  });

  it('the feed itself is deterministic across loads', () => {
    assert.deepEqual(loadMatchFeed(), loadMatchFeed());
  });
});

describe('decision: factor math', () => {
  it('a bare tippable moment scores only base + track record', () => {
    const { confidence } = scoreMoment({ tippable: true, significance: 'low', creatorHitRate: 0 });
    assert.equal(confidence, 20);
  });

  it('called-it adds the flat bonus plus per-minute lead', () => {
    const without = scoreMoment({ tippable: true, significance: 'high', creatorHitRate: 0.5 }).confidence;
    const withCall = scoreMoment({ tippable: true, significance: 'high', creatorHitRate: 0.5, calledIt: true, minute: 60, callMinute: 55 }).confidence;
    assert.equal(withCall - without, 30 + 5);
  });

  it('call lead time is capped at 10 minutes', () => {
    const a = scoreMoment({ tippable: true, significance: 'low', creatorHitRate: 0, calledIt: true, minute: 90, callMinute: 40 });
    const lead = a.factors.find((f) => f.name === 'call-lead');
    assert.equal(lead.points, 10);
  });

  it('confidence never exceeds 99', () => {
    const { confidence } = scoreMoment({ tippable: true, significance: 'high', creatorHitRate: 1, calledIt: true, minute: 90, callMinute: 40 });
    assert.ok(confidence <= 99);
  });

  it('track record clamps below 0 and above 1', () => {
    assert.equal(scoreMoment({ tippable: true, significance: 'low', creatorHitRate: -3 }).confidence, 20);
    assert.equal(scoreMoment({ tippable: true, significance: 'low', creatorHitRate: 7 }).confidence, 36);
  });
});

describe('decision: the rule threshold', () => {
  it('confidence exactly at threshold does NOT tip (strictly greater)', () => {
    // engineer a 70-point moment: base 20 + high 24 + called 30 - lead 0 - track 0, minute==callMinute
    const moment = { tippable: true, significance: 'high', creatorHitRate: 0, calledIt: true, minute: 50, callMinute: 50, headline: 'x' };
    assert.equal(scoreMoment(moment).confidence, 74); // sanity: adjust to hit exact threshold below
    const exact = { tippable: true, significance: 'medium', creatorHitRate: 0.25, calledIt: true, minute: 54, callMinute: 50, headline: 'x' };
    assert.equal(scoreMoment(exact).confidence, 70);
    assert.equal(evaluateMoment(exact, RULE).shouldTip, false);
  });

  it('one point above the threshold tips', () => {
    const above = { tippable: true, significance: 'medium', creatorHitRate: 0.25, calledIt: true, minute: 55, callMinute: 50, headline: 'x' };
    assert.equal(scoreMoment(above).confidence, 71);
    assert.equal(evaluateMoment(above, RULE).shouldTip, true);
  });

  it('non-tippable moments never tip regardless of score', () => {
    const moment = { tippable: false, significance: 'high', creatorHitRate: 1, calledIt: true, minute: 90, callMinute: 40, headline: 'x' };
    assert.equal(evaluateMoment(moment, RULE).shouldTip, false);
  });

  it('a stricter rule declines what a looser rule tips', () => {
    const moment = loadMatchFeed()[4]; // 76% moment
    assert.equal(evaluateMoment(moment, { ...RULE, confidenceThreshold: 70 }).shouldTip, true);
    assert.equal(evaluateMoment(moment, { ...RULE, confidenceThreshold: 80 }).shouldTip, false);
  });
});

describe('decision: the scripted match plays out as engineered', () => {
  const feed = loadMatchFeed();

  it('every expect: tip moment clears the 70% rule', () => {
    for (const m of feed.filter((m) => m.expect === 'tip' || m.expect === 'tip-hero')) {
      const r = evaluateMoment(m, RULE);
      assert.equal(r.shouldTip, true, `seq ${m.seq} should tip (got ${r.confidence}%)`);
    }
  });

  it('every expect: decline moment stays under the 70% rule', () => {
    for (const m of feed.filter((m) => m.expect === 'decline-below-threshold')) {
      const r = evaluateMoment(m, RULE);
      assert.equal(r.shouldTip, false, `seq ${m.seq} should decline (got ${r.confidence}%)`);
    }
  });

  it('the hero moment (90+2 winner) scores 96%', () => {
    const hero = feed.find((m) => m.expect === 'tip-hero');
    assert.equal(scoreMoment(hero).confidence, 96);
  });

  it('the blocked moment WANTS to tip — the model says yes, the policy must say no', () => {
    const blocked = feed.find((m) => m.expect === 'blocked-by-policy');
    assert.equal(evaluateMoment(blocked, RULE).shouldTip, true);
  });

  it('planned tips sum exactly to the session cap', () => {
    const total = [...EXPECTED_SESSION.tips, ...EXPECTED_SESSION.picks].reduce((sum, t) => sum + Number(t.amount) * 100, 0);
    assert.equal(total, 100); // 1.00 USD₮ in cents
  });

  it('suggested amounts follow the expected script', () => {
    for (const expected of EXPECTED_SESSION.tips) {
      const m = feed.find((f) => f.seq === expected.seq);
      assert.equal(evaluateMoment(m, RULE).amount, expected.amount, `seq ${m.seq}`);
    }
  });
});
