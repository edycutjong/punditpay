import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PolicyConfigurationError, PolicyEngine, PolicyViolationError, buildTipPolicy, buildWdkPolicy } from '../src/core/policy.js';
import { parseUSDT } from '../src/core/money.js';

function engineWith(policy) {
  return new PolicyEngine().registerPolicy(policy);
}

const ALLOW_SMALL = {
  id: 'p1',
  rules: [{ name: 'allow-small', operation: 'pay_tip', action: 'ALLOW', conditions: [({ params }) => params.amountMicros <= 100_000n] }],
};

describe('policy: engine semantics mirror WDK', () => {
  it('ungoverned engine allows anything', async () => {
    const r = await new PolicyEngine().simulate('pay_tip', {});
    assert.equal(r.decision, 'ALLOW');
    assert.equal(r.reason, 'no-policies-registered');
  });

  it('governed engine is default-deny for unaddressed operations', async () => {
    const r = await engineWith(ALLOW_SMALL).simulate('drain_wallet', { amountMicros: 1n });
    assert.equal(r.decision, 'DENY');
    assert.equal(r.reason, 'no-applicable-rule');
  });

  it('an ALLOW rule admits a matching operation', async () => {
    const r = await engineWith(ALLOW_SMALL).simulate('pay_tip', { amountMicros: 50_000n });
    assert.equal(r.decision, 'ALLOW');
    assert.equal(r.matched_rule, 'allow-small');
    assert.equal(r.policy_id, 'p1');
  });

  it('a non-matching ALLOW falls through to default-deny', async () => {
    const r = await engineWith(ALLOW_SMALL).simulate('pay_tip', { amountMicros: 200_000n });
    assert.equal(r.decision, 'DENY');
    assert.equal(r.reason, 'no-applicable-rule');
  });

  it('DENY wins over ALLOW even when both match', async () => {
    const engine = engineWith({
      id: 'p2',
      rules: [
        { name: 'allow-all', operation: 'pay_tip', action: 'ALLOW', conditions: [] },
        { name: 'deny-vantage', operation: 'pay_tip', action: 'DENY', reason: 'blocklisted', conditions: [({ params }) => params.to === '@vantage'] },
      ],
    });
    const r = await engine.simulate('pay_tip', { to: '@vantage' });
    assert.equal(r.decision, 'DENY');
    assert.equal(r.matched_rule, 'deny-vantage');
  });

  it('wildcard operation rules apply to everything', async () => {
    const engine = engineWith({ id: 'p3', rules: [{ name: 'allow-everything', operation: '*', action: 'ALLOW', conditions: [] }] });
    assert.equal((await engine.simulate('anything_at_all', {})).decision, 'ALLOW');
  });

  it('conditions may be async', async () => {
    const engine = engineWith({
      id: 'p4',
      rules: [{ name: 'async-allow', operation: 'pay_tip', action: 'ALLOW', conditions: [async ({ params }) => params.ok === true] }],
    });
    assert.equal((await engine.simulate('pay_tip', { ok: true })).decision, 'ALLOW');
    assert.equal((await engine.simulate('pay_tip', { ok: false })).decision, 'DENY');
  });

  it('simulate returns a full trace of consulted rules', async () => {
    const r = await engineWith(ALLOW_SMALL).simulate('pay_tip', { amountMicros: 1n });
    assert.ok(Array.isArray(r.trace));
    assert.equal(r.trace[0].policy_id, 'p1');
    assert.equal(r.trace[0].matched, true);
  });

  it('enforce throws a structured PolicyViolationError on DENY', async () => {
    const engine = engineWith({
      id: 'p5',
      rules: [{ name: 'deny-all', operation: 'pay_tip', action: 'DENY', reason: 'frozen', conditions: [] }],
    });
    await assert.rejects(engine.enforce('pay_tip', {}), (err) => {
      assert.ok(err instanceof PolicyViolationError);
      assert.equal(err.policyId, 'p5');
      assert.equal(err.ruleName, 'deny-all');
      assert.equal(err.reason, 'frozen');
      assert.equal(err.operation, 'pay_tip');
      return true;
    });
  });

  it('enforce passes through on ALLOW', async () => {
    const r = await engineWith(ALLOW_SMALL).enforce('pay_tip', { amountMicros: 1n });
    assert.equal(r.decision, 'ALLOW');
  });

  it('simulate never mutates state — same input, same verdict, no side effects', async () => {
    const engine = engineWith(ALLOW_SMALL);
    const a = await engine.simulate('pay_tip', { amountMicros: 50_000n });
    const b = await engine.simulate('pay_tip', { amountMicros: 50_000n });
    assert.deepEqual(a, b);
  });
});

describe('policy: registration validation', () => {
  it('rejects a policy without id', () => {
    assert.throws(() => new PolicyEngine().registerPolicy({ rules: [] }), PolicyConfigurationError);
  });
  it('rejects duplicate policy ids', () => {
    assert.throws(() => engineWith(ALLOW_SMALL).registerPolicy(ALLOW_SMALL), PolicyConfigurationError);
  });
  it('rejects a policy with no rules', () => {
    assert.throws(() => new PolicyEngine().registerPolicy({ id: 'x', rules: [] }), PolicyConfigurationError);
  });
  it('rejects a rule with a bad action', () => {
    assert.throws(
      () => new PolicyEngine().registerPolicy({ id: 'x', rules: [{ name: 'r', operation: 'op', action: 'MAYBE', conditions: [] }] }),
      PolicyConfigurationError,
    );
  });
  it('rejects a rule without conditions array', () => {
    assert.throws(
      () => new PolicyEngine().registerPolicy({ id: 'x', rules: [{ name: 'r', operation: 'op', action: 'ALLOW' }] }),
      PolicyConfigurationError,
    );
  });
});

describe('policy: the PunditPay session guardrail', () => {
  function sessionOf(state) {
    return {
      spentMicros: () => state.spent,
      tipCount: () => state.tips,
      pickCount: () => state.picks,
    };
  }
  const LIMITS = {
    sessionCapMicros: parseUSDT('1.00'),
    maxTipMicros: parseUSDT('0.25'),
    maxTips: 6,
    maxPickMicros: parseUSDT('0.25'),
    maxPicks: 1,
  };

  function guardrail(state) {
    return engineWith(buildTipPolicy(LIMITS, sessionOf(state)));
  }

  it('allows a normal tip inside all limits', async () => {
    const r = await guardrail({ spent: 0n, tips: 0, picks: 0 }).simulate('pay_tip', { amountMicros: parseUSDT('0.15'), to: '@vantage' });
    assert.equal(r.decision, 'ALLOW');
  });

  it('Σ session tips ≤ cap always holds: a tip that would cross the cap is DENIED', async () => {
    const r = await guardrail({ spent: parseUSDT('1.00'), tips: 4, picks: 1 }).simulate('pay_tip', { amountMicros: parseUSDT('0.25'), to: '@vantage' });
    assert.equal(r.decision, 'DENY');
    assert.equal(r.matched_rule, 'block-over-cap');
    assert.equal(r.reason, 'would exceed session cap');
  });

  it('a tip landing exactly ON the cap is allowed (≤, not <)', async () => {
    const r = await guardrail({ spent: parseUSDT('0.75'), tips: 3, picks: 1 }).simulate('pay_tip', { amountMicros: parseUSDT('0.25'), to: '@vantage' });
    assert.equal(r.decision, 'ALLOW');
  });

  it('a single over-sized tip is DENIED by the per-tip maximum', async () => {
    const r = await guardrail({ spent: 0n, tips: 0, picks: 0 }).simulate('pay_tip', { amountMicros: parseUSDT('0.50'), to: '@vantage' });
    assert.equal(r.decision, 'DENY');
    assert.equal(r.matched_rule, 'block-over-per-tip-max');
  });

  it('the tip-count rail fires when tips are exhausted', async () => {
    const r = await guardrail({ spent: parseUSDT('0.30'), tips: 6, picks: 0 }).simulate('pay_tip', { amountMicros: parseUSDT('0.05'), to: '@vantage' });
    assert.equal(r.decision, 'DENY');
    assert.equal(r.matched_rule, 'block-over-tip-count');
  });

  it('zero and negative amounts never pass', async () => {
    const g = guardrail({ spent: 0n, tips: 0, picks: 0 });
    assert.equal((await g.simulate('pay_tip', { amountMicros: 0n, to: '@v' })).decision, 'DENY');
    assert.equal((await g.simulate('pay_tip', { amountMicros: -100n, to: '@v' })).decision, 'DENY');
  });

  it('malformed amounts (Number, string, missing) are DENIED without throwing (audit B5)', async () => {
    const g = guardrail({ spent: 0n, tips: 0, picks: 0 });
    for (const amountMicros of [150000, '150000', undefined, null]) {
      const r = await g.simulate('pay_tip', { amountMicros, to: '@vantage' });
      assert.equal(r.decision, 'DENY', `amountMicros=${String(amountMicros)}`);
      assert.equal(r.matched_rule, 'block-malformed-amount');
    }
  });

  it('the recipient allowlist also governs buy_pick (audit B7)', async () => {
    const engine = engineWith(
      buildTipPolicy({ ...LIMITS, allowedRecipients: ['@tacticsroom'] }, sessionOf({ spent: 0n, tips: 0, picks: 0 })),
    );
    assert.equal((await engine.simulate('buy_pick', { amountMicros: parseUSDT('0.25'), to: '@tacticsroom' })).decision, 'ALLOW');
    const denied = await engine.simulate('buy_pick', { amountMicros: parseUSDT('0.25'), to: '@shadyseller' });
    assert.equal(denied.decision, 'DENY');
    assert.equal(denied.matched_rule, 'block-unknown-recipient');
  });

  it('a recipient outside the allowlist is DENIED when an allowlist exists', async () => {
    const engine = engineWith(
      buildTipPolicy({ ...LIMITS, allowedRecipients: ['@vantage'] }, sessionOf({ spent: 0n, tips: 0, picks: 0 })),
    );
    assert.equal((await engine.simulate('pay_tip', { amountMicros: 1000n, to: '@vantage' })).decision, 'ALLOW');
    const denied = await engine.simulate('pay_tip', { amountMicros: 1000n, to: '@stranger' });
    assert.equal(denied.decision, 'DENY');
    assert.equal(denied.matched_rule, 'block-unknown-recipient');
  });

  it('allows the single pre-authorized pick within budget', async () => {
    const r = await guardrail({ spent: parseUSDT('0.25'), tips: 2, picks: 0 }).simulate('buy_pick', { amountMicros: parseUSDT('0.25') });
    assert.equal(r.decision, 'ALLOW');
  });

  it('a second pick is DENIED', async () => {
    const r = await guardrail({ spent: parseUSDT('0.50'), tips: 2, picks: 1 }).simulate('buy_pick', { amountMicros: parseUSDT('0.25') });
    assert.equal(r.decision, 'DENY');
  });

  it('a pick that would cross the session cap is DENIED (shared cap)', async () => {
    const r = await guardrail({ spent: parseUSDT('0.90'), tips: 3, picks: 0 }).simulate('buy_pick', { amountMicros: parseUSDT('0.25') });
    assert.equal(r.decision, 'DENY');
  });

  it('an operation the model invents is DENIED by default (no-applicable-rule)', async () => {
    const r = await guardrail({ spent: 0n, tips: 0, picks: 0 }).simulate('send_all_funds', { amountMicros: 1n });
    assert.equal(r.decision, 'DENY');
    assert.equal(r.reason, 'no-applicable-rule');
  });

  it('policy verdicts follow live session state — the same tip flips to DENY as spending accrues', async () => {
    const state = { spent: 0n, tips: 0, picks: 0 };
    const engine = guardrail(state);
    const tip = { amountMicros: parseUSDT('0.25'), to: '@vantage' };
    assert.equal((await engine.simulate('pay_tip', tip)).decision, 'ALLOW');
    state.spent = parseUSDT('0.80');
    assert.equal((await engine.simulate('pay_tip', tip)).decision, 'DENY');
  });
});

describe('policy: the WDK in-wallet mirror policy', () => {
  it('shapes a project-scope WDK policy with a sendTransaction cap', () => {
    const policy = buildWdkPolicy({ sessionCapSettleUnits: 1000n }, { spentSettleUnits: () => 0n });
    assert.equal(policy.scope, 'project');
    assert.ok(policy.rules.some((r) => r.operation === 'sendTransaction' && r.action === 'ALLOW'));
  });

  it('includes the sign allowance (WDK default-deny would refuse x402 signatures otherwise)', () => {
    const policy = buildWdkPolicy({ sessionCapSettleUnits: 1000n }, { spentSettleUnits: () => 0n });
    assert.ok(policy.rules.some((r) => r.operation === 'sign' && r.action === 'ALLOW'));
  });

  it('its cap condition math matches the core policy (≤ cap allowed, over denied)', async () => {
    const spent = { value: 0n };
    const policy = buildWdkPolicy({ sessionCapSettleUnits: 1000n }, { spentSettleUnits: () => spent.value });
    const rule = policy.rules.find((r) => r.name === 'allow-tips-under-session-cap');
    const holds = async (params) => {
      for (const c of rule.conditions) if (!(await c({ params }))) return false;
      return true;
    };
    assert.equal(await holds({ value: 1000n }), true);
    assert.equal(await holds({ value: 1001n }), false);
    spent.value = 900n;
    assert.equal(await holds({ value: 100n }), true);
    assert.equal(await holds({ value: 101n }), false);
  });
});
