/**
 * QVAC brain — a real GGUF model deciding to spend real money, on-device.
 *
 * `completion()` with tool-calling via @qvac/sdk: the model receives the
 * match moment + the user's rule and EITHER emits a pay_tip/buy_pick tool
 * call or explains in a sentence why it is holding back. Nothing here talks
 * to any cloud — the model file lives on this machine (first run downloads
 * it, then it's cached locally).
 *
 * Default model: QWEN3_1_7B_INST_Q4 — the QVAC docs' canonical tool-calling
 * model, and the one that emitted correct structured calls in our live
 * testing (142 tok/s on an M-series GPU; see docs/friction-log.md for the
 * measured comparison against the 0.6B/1B alternatives).
 */

import { buildMomentPrompt, buildSystemPrompt } from '../core/prompts.js';
import { scoreMoment } from '../core/decision.js';
import { formatUSDT } from '../core/money.js';

export const MODEL_CHOICES = Object.freeze({
  'llama-tools-1b': 'LLAMA_TOOL_CALLING_1B_INST_Q4_K',
  'qwen-1.7b': 'QWEN3_1_7B_INST_Q4',
  'qwen-600m': 'QWEN3_600M_INST_Q4',
  'llama-1b': 'LLAMA_3_2_1B_INST_Q4_0',
});

// Llama 3.x tool fine-tunes emit native pythonic tool headers; QVAC's
// auto-router defaults to hermes, so the call parses to nothing without this
// (documented in QVAC "Tool-call dialect routing", verified live).
const MODEL_DIALECTS = Object.freeze({
  'llama-tools-1b': 'pythonic',
  'llama-1b': 'pythonic',
});

export const DEFAULT_MODEL = 'qwen-1.7b';

/**
 * @param {{model?: keyof typeof MODEL_CHOICES, tools: Array, onProgress?: Function,
 *          onToken?: (text: string) => void}} opts
 */
export function createQvacBrain({ model = DEFAULT_MODEL, tools, onProgress, onToken } = {}) {
  let sdk = null;
  let modelId = null;
  let lastStats = null;

  const constantName = MODEL_CHOICES[model];
  if (!constantName) throw new Error(`unknown model "${model}" — options: ${Object.keys(MODEL_CHOICES).join(', ')}`);

  return {
    kind: 'qvac',
    label: `QVAC on-device model (${constantName})`,

    stats() {
      return lastStats;
    },

    // ── everything below drives the live on-device model, so it can't run in
    // CI (needs the ~1GB GGUF). It is one contiguous coverage-disabled block —
    // no enabled islands — and its PURE sub-steps (parseContentToolCall,
    // normalizeArgs, normalizeArgKeys, stripThinkMarkers, extractAfterThink)
    // are exported and unit-tested directly. Proven end-to-end by the manual
    // `--brain=qvac` run, never by mocking @qvac/sdk.
    /* node:coverage disable */
    /** Load the SDK + model. First call downloads the GGUF to the local cache. */
    async ready() {
      if (modelId) return true;
      sdk = await import('@qvac/sdk');
      const modelSrc = sdk[constantName];
      if (!modelSrc) throw new Error(`@qvac/sdk does not export ${constantName}`);
      modelId = await sdk.loadModel({
        modelSrc,
        modelType: 'llm',
        modelConfig: { ctx_size: 4096, tools: true },
        onProgress,
      });
      return true;
    },

    async evaluate(moment, { rule, capState }) {
      if (!modelId) await this.ready();
      const scored = scoreMoment(moment);
      const history = [
        {
          role: 'system',
          content: buildSystemPrompt({
            rule,
            capState: {
              spent: formatUSDT(capState.spentMicros),
              cap: formatUSDT(capState.capMicros),
              tipsLeft: capState.tipsLeft,
            },
          }),
        },
        { role: 'user', content: buildMomentPrompt(moment, scored) },
      ];

      const toolDialect = MODEL_DIALECTS[model];
      const run = sdk.completion({ modelId, history, stream: true, tools, ...(toolDialect ? { toolDialect } : {}) });

      const reasoningLines = [];
      let currentLine = '';
      for await (const token of run.tokenStream) {
        onToken?.(token);
        currentLine += token;
        if (currentLine.includes('\n')) {
          const parts = currentLine.split('\n');
          currentLine = parts.pop();
          reasoningLines.push(...parts.filter((l) => l.trim().length > 0));
        }
      }
      if (currentLine.trim().length > 0) reasoningLines.push(currentLine.trim());

      const toolCalls = await run.toolCalls;
      lastStats = await run.stats;

      let call = toolCalls?.[0] ?? null;
      const cleanLines = reasoningLines.map(stripThinkMarkers).filter((l) => l.length > 0);
      let holdBackReason = null;

      // Fallback: small models sometimes leak the call into the CONTENT
      // stream as a literal <tool_call>{json}</tool_call> block instead of
      // the native channel. Parse it — the result still passes the same
      // schema validation and policy gate as a native call.
      if (!call) {
        const leaked = parseContentToolCall(reasoningLines);
        if (leaked && (leaked.name === 'pay_tip' || leaked.name === 'buy_pick')) {
          call = leaked;
        } else if (leaked && /^hold/.test(leaked.name ?? '')) {
          holdBackReason = leaked.arguments?.reason ?? null;
        }
      }

      const afterThink = extractAfterThink(reasoningLines);
      return {
        reasoningLines: cleanLines.length > 0 ? cleanLines : [`(model emitted a tool call with no prose)`],
        toolCall: call ? { name: call.name, arguments: normalizeArgKeys(normalizeArgs(call.arguments), scored) } : null,
        holdBack: call ? null : (holdBackReason || afterThink || cleanLines.join(' ')).slice(0, 240) || 'model held back without explanation',
        stats: lastStats,
      };
    },

    async dispose() {
      if (sdk && modelId) {
        await sdk.unloadModel({ modelId, clearStorage: false });
        modelId = null;
      }
    },
    /* node:coverage enable */
  };
}

/** Models sometimes emit JSON-encoded strings for arguments; normalize both shapes. */
export function normalizeArgs(args) {
  if (typeof args === 'string') {
    try {
      return JSON.parse(args);
    } catch {
      return { _raw: args };
    }
  }
  return args ?? {};
}

/**
 * Small models drift on argument NAMES while getting the values right
 * (observed live: qwen-1.7b emitted `creator` for `to`). Map the common
 * aliases onto the schema and, when the model omits its confidence number,
 * carry over the deterministic score it was shown. Values are never invented
 * — a call with a missing amount or recipient still fails validation.
 */
export function normalizeArgKeys(args, scored) {
  const out = { ...args };
  if (out.to == null && typeof out.creator === 'string') out.to = out.creator;
  if (out.to == null && typeof out.handle === 'string') out.to = out.handle;
  if (out.from == null && typeof out.seller === 'string') out.from = out.seller;
  if (out.amount_usdt == null && typeof out.amount === 'string') out.amount_usdt = out.amount;
  if (out.confidence == null && scored?.confidence != null) out.confidence = scored.confidence;
  return out;
}

export function stripThinkMarkers(line) {
  return line.replace(/<\/?think>/g, '').trim();
}

/**
 * Extract a <tool_call>{json}</tool_call> block leaked into content text.
 * Exported for the regression test: the non-greedy capture relies on the
 * closing `</tool_call>` anchor to backtrack past inner `}` and grab the FULL
 * (possibly nested) object — a subtle property a naive edit could break, which
 * would silently drop real payments. Do not simplify without re-running the test.
 */
export function parseContentToolCall(lines) {
  const text = Array.isArray(lines) ? lines.join('\n') : String(lines ?? '');
  const m = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/.exec(text);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]);
    return parsed && typeof parsed.name === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/** Prefer the model's post-<think> summary as the hold-back sentence. */
export function extractAfterThink(lines) {
  const idx = lines.findIndex((l) => l.includes('</think>'));
  if (idx === -1) return null;
  return lines
    .slice(idx)
    .map(stripThinkMarkers)
    .filter((l) => l.length > 0)
    .join(' ')
    .trim();
}
