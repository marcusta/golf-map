// EXAMPLE rule ONLY — exercises the evaluator; NOT a catalogue rule.
// The real v1 rule set (green-slope-half, short-side-guard, par5-attack, …)
// lands in later tasks (feature-smart-caddy.md §5). This one exists so the
// engine has something to run in tests and so the rule-authoring shape is
// documented by example. Delete or ignore when real rules exist.
//
// It fires on any long par (≥ 5) and simply notes it is a scoring hole. Pure
// and self-gating like every rule.

import { type CaddyAdvice, type CaddyContext, type CaddyRule } from '../rule';

export const exampleLongParRule: CaddyRule = {
    id: 'example-long-par',
    appliesTo(ctx: CaddyContext): boolean {
        return ctx.hole.par >= 5;
    },
    evaluate(ctx: CaddyContext): CaddyAdvice[] {
        return [
            {
                ruleId: 'example-long-par',
                kind: 'warning',
                priority: 1,
                confidence: 1,
                headline: `Par ${ctx.hole.par} — a scoring hole.`,
                detail: 'Example rule; not real caddy advice.',
            },
        ];
    },
};
