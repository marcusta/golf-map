import Foundation

/// Smart-caddy evaluator — the FIXED half of the open–closed rule system.
/// Faithful Swift port of `shared/strategy/caddy/run.ts`: conflict resolution
/// lives HERE, never in a rule. Pipeline: filter → evaluate → apply vetoes →
/// rank → dedupe. Pure and deterministic: identical inputs always yield the
/// identical ordered advice list (the sort is total — every tie is broken — so
/// there is no ordering flicker between recomputes). The two MUST stay
/// numerically identical: ported tests + TS-generated golden fixtures pin it.
///
/// Ranking (D12): rank = priority × confidence. Where a rule opts in via
/// `riskWeighted`, its priority is first scaled by the player's riskAversion
/// (D16), so a cautious player floats safety advice up.

/// Effective priority used for ranking. Risk-neutral advice ranks on its raw
/// priority; risk-weighted advice scales priority by the player's riskAversion,
/// lerped between half and full priority (so it is quieter at 0, not silent).
private func effectivePriority(_ advice: CaddyAdvice, _ risk: RiskProfile) -> Double {
    if !advice.riskWeighted { return advice.priority }
    let a = caddyClamp01(risk.riskAversion)
    return advice.priority * (0.5 + 0.5 * a)
}

/// Ranking key: effective priority × confidence (D12).
private func rankOf(_ advice: CaddyAdvice, _ risk: RiskProfile) -> Double {
    effectivePriority(advice, risk) * advice.confidence
}

private func caddyClamp01(_ x: Double) -> Double {
    x < 0 ? 0 : (x > 1 ? 1 : x)
}

/// Run the caddy: gather advice from every applicable rule, resolve vetoes, and
/// return a deterministically ranked, deduped list (highest rank first). Mirror
/// of `run.ts` `runCaddy`.
public func runCaddy<Club: ClubSpec>(
    _ ctx: CaddyContext<Club>,
    _ rules: [CaddyRule<Club>]
) -> [CaddyAdvice] {
    // 1 + 2: filter then evaluate.
    var collected: [CaddyAdvice] = []
    for rule in rules {
        if !rule.appliesTo(ctx) { continue }
        collected.append(contentsOf: rule.evaluate(ctx))
    }

    // 3: gather the set of vetoed rule ids (only vetoes from emitted advice).
    var vetoed = Set<String>()
    for advice in collected {
        for id in advice.vetoes ?? [] { vetoed.insert(id) }
    }

    // 4: rank. Vetoed advice is demoted (sorts strictly after all non-vetoed
    // advice) but not dropped. Within each band, higher rank first; ties broken
    // by the total comparator, then original index (JS Array.sort is stable).
    let risk = ctx.risk
    let ranked = collected.enumerated().sorted { lhs, rhs in
        let a = lhs.element, b = rhs.element
        let av = vetoed.contains(a.ruleId) ? 1 : 0
        let bv = vetoed.contains(b.ruleId) ? 1 : 0
        if av != bv { return av < bv } // non-vetoed (0) before vetoed (1)
        let c = compareAdvice(a, b, risk)
        if c != 0 { return c < 0 }
        return lhs.offset < rhs.offset
    }.map(\.element)

    // 5: dedupe identical recommendations, keeping the first (highest-ranked).
    var seen = Set<String>()
    var out: [CaddyAdvice] = []
    for advice in ranked {
        let key = "\(advice.ruleId) \(advice.kind.rawValue) \(advice.headline)"
        if seen.contains(key) { continue }
        seen.insert(key)
        out.append(advice)
    }
    return out
}

/// Total order over advice within one veto band — higher rank first, then a
/// deterministic tie-break. Returns negative when `a` sorts before `b`, mirror
/// of the TS numeric comparator (`run.ts` `compareAdvice`). No two distinct
/// advices ever compare 0 unless identical on all four keys.
func compareAdvice(_ a: CaddyAdvice, _ b: CaddyAdvice, _ risk: RiskProfile) -> Int {
    let ra = rankOf(a, risk)
    let rb = rankOf(b, risk)
    if ra != rb { return ra > rb ? -1 : 1 } // descending rank
    if a.priority != b.priority { return a.priority > b.priority ? -1 : 1 }
    if a.confidence != b.confidence { return a.confidence > b.confidence ? -1 : 1 }
    if a.ruleId != b.ruleId { return a.ruleId < b.ruleId ? -1 : 1 }
    if a.headline != b.headline { return a.headline < b.headline ? -1 : 1 }
    return 0
}
