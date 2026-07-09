/**
 * Transaction-Policy engine — the agent's hard spending guardrail.
 *
 * Semantics deliberately mirror @tetherto/wdk's policy engine so the SAME
 * policy definitions drive both layers of enforcement:
 *
 *   1. this engine, consulted BEFORE any settlement is attempted (pre-flight), and
 *   2. wdk.registerPolicy(...) in-wallet when the real WDK wallet is active
 *      (belt and braces: the wallet itself refuses to sign over-cap).
 *
 * Mirrored behavior: ALLOW/DENY rules with condition functions, DENY wins,
 * default-deny on governed operations (`reason: 'no-applicable-rule'`),
 * structured PolicyViolationError, and a simulate() that returns
 * { decision, policy_id, matched_rule, reason, trace } without executing.
 */

export class PolicyViolationError extends Error {
  constructor({ policyId, ruleName, reason, operation, params }) {
    super(`policy ${policyId ?? '(default-deny)'} denied ${operation}: ${reason}`);
    this.name = 'PolicyViolationError';
    this.policyId = policyId ?? null;
    this.ruleName = ruleName ?? null;
    this.reason = reason;
    this.operation = operation;
    this.params = params;
  }
}

export class PolicyConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PolicyConfigurationError';
  }
}

const ACTIONS = new Set(['ALLOW', 'DENY']);

export class PolicyEngine {
  constructor() {
    this.policies = [];
  }

  /**
   * @param {{id: string, name?: string, rules: Array<{name: string, operation: string,
   *          action: 'ALLOW'|'DENY', conditions: Array<Function>}>}} policy
   */
  registerPolicy(policy) {
    if (!policy?.id) throw new PolicyConfigurationError('policy.id is required');
    if (this.policies.some((p) => p.id === policy.id)) {
      throw new PolicyConfigurationError(`duplicate policy id: ${policy.id}`);
    }
    if (!Array.isArray(policy.rules) || policy.rules.length === 0) {
      throw new PolicyConfigurationError(`policy ${policy.id} has no rules`);
    }
    for (const rule of policy.rules) {
      if (!rule.name) throw new PolicyConfigurationError(`policy ${policy.id}: every rule needs a name`);
      if (!rule.operation) throw new PolicyConfigurationError(`policy ${policy.id}: rule ${rule.name} needs an operation`);
      if (!ACTIONS.has(rule.action)) throw new PolicyConfigurationError(`policy ${policy.id}: rule ${rule.name} action must be ALLOW or DENY`);
      if (!Array.isArray(rule.conditions)) throw new PolicyConfigurationError(`policy ${policy.id}: rule ${rule.name} conditions must be an array`);
    }
    this.policies.push(policy);
    return this;
  }

  get governed() {
    return this.policies.length > 0;
  }

  /**
   * Evaluate an operation without executing it.
   * @returns {Promise<{decision:'ALLOW'|'DENY', policy_id:string|null, matched_rule:string|null, reason:string, trace:Array}>}
   */
  async simulate(operation, params, context = {}) {
    const trace = [];
    if (!this.governed) {
      return { decision: 'ALLOW', policy_id: null, matched_rule: null, reason: 'no-policies-registered', trace };
    }

    let allow = null; // first matching ALLOW, remembered while we keep scanning for DENYs
    for (const policy of this.policies) {
      for (const rule of policy.rules) {
        if (rule.operation !== operation && rule.operation !== '*') continue;
        const matched = await conditionsHold(rule.conditions, { operation, params, context });
        trace.push({ policy_id: policy.id, rule: rule.name, action: rule.action, matched });
        if (!matched) continue;
        if (rule.action === 'DENY') {
          // DENY wins immediately, across all policies.
          return {
            decision: 'DENY',
            policy_id: policy.id,
            matched_rule: rule.name,
            reason: rule.reason ?? `denied by rule ${rule.name}`,
            trace,
          };
        }
        allow ??= { policy_id: policy.id, matched_rule: rule.name };
      }
    }

    if (allow) {
      return { decision: 'ALLOW', policy_id: allow.policy_id, matched_rule: allow.matched_rule, reason: 'allowed', trace };
    }
    // Default-deny: a governed engine refuses anything no ALLOW rule addressed.
    return { decision: 'DENY', policy_id: null, matched_rule: null, reason: 'no-applicable-rule', trace };
  }

  /** Evaluate and throw PolicyViolationError on DENY. Returns the simulation on ALLOW. */
  async enforce(operation, params, context = {}) {
    const result = await this.simulate(operation, params, context);
    if (result.decision === 'DENY') {
      throw new PolicyViolationError({
        policyId: result.policy_id,
        ruleName: result.matched_rule,
        reason: result.reason,
        operation,
        params,
      });
    }
    return result;
  }
}

async function conditionsHold(conditions, input) {
  for (const condition of conditions) {
    if (!(await condition(input))) return false;
  }
  return true;
}

/**
 * PunditPay's concrete guardrail: a session spend cap shared by tips AND pick
 * purchases, a per-tip ceiling, a tip-count limit, a single-pick budget, and a
 * recipient allowlist — all enforced before any signature happens.
 * `session` is live state owned by the ledger.
 *
 * The engine is default-deny, so any operation not ALLOWed here (including a
 * hallucinated tool call the model might invent) is refused outright.
 *
 * @param {{sessionCapMicros: bigint, maxTipMicros: bigint, maxTips: number,
 *          maxPickMicros?: bigint, maxPicks?: number, allowedRecipients?: string[]}} limits
 * @param {{spentMicros: () => bigint, tipCount: () => number, pickCount: () => number}} session
 */
export function buildTipPolicy(limits, session) {
  const { sessionCapMicros, maxTipMicros, maxTips, allowedRecipients } = limits;
  const maxPickMicros = limits.maxPickMicros ?? 0n;
  const maxPicks = limits.maxPicks ?? 0;
  // Amounts are bigint micros or they are nothing: a malformed amount matches
  // its own DENY rule instead of crashing bigint arithmetic mid-evaluation.
  const validAmount = (params) => typeof params.amountMicros === 'bigint' && params.amountMicros > 0n;
  const rules = [
    {
      name: 'block-malformed-amount',
      operation: '*',
      action: 'DENY',
      reason: 'amount must be a positive bigint micros value',
      conditions: [({ params }) => !validAmount(params)],
    },
    {
      name: 'within-session-cap',
      operation: 'pay_tip',
      action: 'ALLOW',
      conditions: [
        ({ params }) => validAmount(params),
        ({ params }) => params.amountMicros <= maxTipMicros,
        ({ params }) => session.spentMicros() + params.amountMicros <= sessionCapMicros,
        () => session.tipCount() < maxTips,
        ({ params }) => !allowedRecipients || allowedRecipients.includes(params.to),
      ],
    },
    {
      name: 'block-over-cap',
      operation: 'pay_tip',
      action: 'DENY',
      reason: 'would exceed session cap',
      conditions: [({ params }) => validAmount(params) && session.spentMicros() + params.amountMicros > sessionCapMicros],
    },
    {
      name: 'block-over-per-tip-max',
      operation: 'pay_tip',
      action: 'DENY',
      reason: 'single tip exceeds per-tip maximum',
      conditions: [({ params }) => validAmount(params) && params.amountMicros > maxTipMicros],
    },
    {
      name: 'block-over-tip-count',
      operation: 'pay_tip',
      action: 'DENY',
      reason: 'session tip count exhausted',
      conditions: [() => session.tipCount() >= maxTips],
    },
    {
      name: 'within-pick-budget',
      operation: 'buy_pick',
      action: 'ALLOW',
      conditions: [
        ({ params }) => validAmount(params),
        ({ params }) => params.amountMicros <= maxPickMicros,
        ({ params }) => session.spentMicros() + params.amountMicros <= sessionCapMicros,
        () => session.pickCount() < maxPicks,
        ({ params }) => !allowedRecipients || allowedRecipients.includes(params.to),
      ],
    },
    {
      name: 'block-over-pick-budget',
      operation: 'buy_pick',
      action: 'DENY',
      reason: 'pick purchase exceeds budget or pick allowance',
      conditions: [
        ({ params }) =>
          !validAmount(params) ||
          params.amountMicros > maxPickMicros ||
          session.pickCount() >= maxPicks ||
          session.spentMicros() + params.amountMicros > sessionCapMicros,
      ],
    },
  ];
  if (allowedRecipients) {
    rules.push({
      name: 'block-unknown-recipient',
      operation: '*',
      action: 'DENY',
      reason: 'recipient is not on the allowlist',
      conditions: [({ params }) => params.to !== undefined && !allowedRecipients.includes(params.to)],
    });
  }
  return { id: 'punditpay-session-guardrail', name: 'PunditPay session guardrail', rules };
}

/**
 * Translate the same limits into a @tetherto/wdk policy object for in-wallet
 * enforcement (second layer). WDK conditions receive ({ params }) where params
 * are the sendTransaction arguments in the settlement unit (sats for Spark).
 *
 * @param {{sessionCapSettleUnits: bigint}} limits
 * @param {{spentSettleUnits: () => bigint}} session
 */
export function buildWdkPolicy(limits, session) {
  return {
    id: 'punditpay-wallet-cap',
    name: 'PunditPay in-wallet spend cap',
    scope: 'project',
    rules: [
      {
        name: 'allow-tips-under-session-cap',
        operation: 'sendTransaction',
        action: 'ALLOW',
        conditions: [
          ({ params }) => BigInt(params.value) > 0n,
          ({ params }) => session.spentSettleUnits() + BigInt(params.value) <= limits.sessionCapSettleUnits,
        ],
      },
      {
        // WDK is default-deny on governed accounts, and `sign` is a governed
        // operation — without this rule the x402 payment signature itself
        // would be refused. Message signing moves no funds.
        name: 'allow-x402-message-signing',
        operation: 'sign',
        action: 'ALLOW',
        conditions: [],
      },
    ],
  };
}
