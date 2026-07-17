import Foundation

/// Voice locale for pin-placement dictation (docs/
/// feature-laser-pin-and-calibration.md §4). Backing value is the
/// `SFSpeechRecognizer` locale identifier so the recognizer setting and the
/// parser share one source of truth.
enum PinVoiceLocale: String, CaseIterable, Sendable {
    case swedish = "sv-SE"
    case english = "en-US"
}

/// Deterministic, offline token-grammar parser for spoken pin placement
/// (spec §4.2). Turns a recognized utterance into candidate `PinPhrase`
/// interpretations, best first; the draggable confirm UI (L2) resolves any
/// remaining ambiguity, so a misparse is a drag-fix, never a silent wrong
/// distance.
///
/// Design constraints (binding):
/// - No LLM and no locale-dependent system APIs in the hot path — both
///   languages share ONE grammar. `locale` only sets which number-word
///   vocabulary is preferred when a single token is ambiguous.
/// - Digits are the PRIMARY number path (`SFSpeechRecognizer` usually emits
///   "143", "4,5"); number words are best-effort.
/// - Every word-derived fraction maps through `PinWordFractions`, never a
///   literal, so tuning happens in exactly one place.
///
/// Deliberately unsupported (documented, returns no candidate):
/// - A sheet lateral measured "from right" (`N from right`) — `PinPhrase` only
///   carries `lateralFromLeftM`, and we cannot convert metres-from-right to
///   metres-from-left without the green width here. `.sheet` is emitted only
///   for front + left; a `from right` or `from back` numeric clause is dropped.
/// - A depth measured "from back" (`N from back`) — `.sheet`/`.hybrid` only
///   carry `depthFromFrontM`; no green depth is available in the parser to
///   convert, so the clause is dropped.
enum PinPhraseParser {

    /// Parses a recognized utterance into candidate interpretations, best
    /// first. Empty = no parse. Deterministic — no LLM, no locale-dependent
    /// system APIs; both languages are one grammar, `locale` only picks the
    /// number-word vocabulary preference when a token is ambiguous.
    static func parse(_ text: String, locale: PinVoiceLocale) -> [PinPhrase] {
        let words = normalize(text)
        let tokens = tokenize(words, locale: locale)
        return interpret(tokens)
    }

    /// Extract the rangefinder number from a spoken/typed laser utterance.
    /// This deliberately goes through `parse` instead of owning a second
    /// number grammar: digits, English number words, Swedish compounds and
    /// decimal-comma handling therefore stay bit-for-bit identical to pin
    /// entry (round-loop R7).
    static func laserDistance(_ text: String, locale: PinVoiceLocale) -> Double? {
        parse(text, locale: locale).lazy.compactMap { phrase in
            guard case let .laser(distanceM, _) = phrase else { return nil }
            return distanceM
        }.first
    }

    // MARK: - Tokens

    /// The classified token stream. Units and noise words are never emitted —
    /// they are dropped during tokenization.
    private enum Tok: Equatable {
        case number(Double)
        case from
        /// `far == false` → front (near end), `true` → back (far end).
        case edgeDepth(far: Bool)
        /// `far == false` → left (near side), `true` → right (far side).
        case edgeLat(far: Bool)
        /// middle / center / mitten.
        case position
        /// far / långt / close / nära — pushes an edge to its extreme value.
        case modifier
    }

    // MARK: - Normalization

    /// Lowercase, split Swedish decimal comma from clause commas, drop
    /// punctuation and hyphens, collapse whitespace. A comma or period between
    /// two digits is a decimal point ("4,5" → "4.5"); otherwise it is a
    /// separator. Hyphens ("forty-three") split into words the number composer
    /// re-joins.
    private static func normalize(_ text: String) -> [String] {
        let chars = Array(text.lowercased())
        var out = ""
        out.reserveCapacity(chars.count)
        for (i, c) in chars.enumerated() {
            switch c {
            case ",", ".":
                let prevDigit = i > 0 && chars[i - 1].isNumber
                let nextDigit = i + 1 < chars.count && chars[i + 1].isNumber
                out.append(prevDigit && nextDigit ? "." : " ")
            case "-", "_", "/":
                out.append(" ")
            default:
                out.append(c)
            }
        }
        return out.split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "\n" })
            .map(String.init)
    }

    // MARK: - Tokenization

    private static func tokenize(_ words: [String], locale: PinVoiceLocale) -> [Tok] {
        var tokens: [Tok] = []
        var i = 0
        while i < words.count {
            if let (value, consumed) = consumeNumber(words, from: i, locale: locale) {
                tokens.append(.number(value))
                i += consumed
                continue
            }
            if let tok = classify(words[i]) {
                tokens.append(tok)
            }
            // else: unit or noise word — dropped.
            i += 1
        }
        return tokens
    }

    /// Classifies a single non-number word. `nil` = a unit or noise word that
    /// carries no grammar meaning (skipped): `m|meter|meters|metres`, and
    /// `pin|flag|flaggan|flagga|pinnen|hål|is|är|the|på|and|och|to|a|an` etc.
    private static func classify(_ w: String) -> Tok? {
        switch w {
        case "from", "från":
            return .from
        case "front", "fronten", "framkant", "fram":
            return .edgeDepth(far: false)
        case "back", "bak", "bakkant", "baken":
            return .edgeDepth(far: true)
        case "left", "vänster":
            return .edgeLat(far: false)
        case "right", "höger":
            return .edgeLat(far: true)
        case "middle", "center", "centre", "mitten", "mitt":
            return .position
        case "far", "långt", "long", "close", "nära":
            return .modifier
        default:
            return nil
        }
    }

    // MARK: - Number words

    private enum NumKind: Sendable {
        case ones, teen, ten, hundred
    }

    private static let englishWords: [String: (Int, NumKind)] = [
        "one": (1, .ones), "two": (2, .ones), "three": (3, .ones), "four": (4, .ones),
        "five": (5, .ones), "six": (6, .ones), "seven": (7, .ones), "eight": (8, .ones),
        "nine": (9, .ones), "zero": (0, .ones),
        "ten": (10, .teen), "eleven": (11, .teen), "twelve": (12, .teen),
        "thirteen": (13, .teen), "fourteen": (14, .teen), "fifteen": (15, .teen),
        "sixteen": (16, .teen), "seventeen": (17, .teen), "eighteen": (18, .teen),
        "nineteen": (19, .teen),
        "twenty": (20, .ten), "thirty": (30, .ten), "forty": (40, .ten),
        "fifty": (50, .ten), "sixty": (60, .ten), "seventy": (70, .ten),
        "eighty": (80, .ten), "ninety": (90, .ten),
        "hundred": (100, .hundred),
    ]

    private static let swedishWords: [String: (Int, NumKind)] = [
        "noll": (0, .ones), "en": (1, .ones), "ett": (1, .ones), "två": (2, .ones),
        "tre": (3, .ones), "fyra": (4, .ones), "fem": (5, .ones), "sex": (6, .ones),
        "sju": (7, .ones), "åtta": (8, .ones), "nio": (9, .ones),
        "tio": (10, .teen), "elva": (11, .teen), "tolv": (12, .teen),
        "tretton": (13, .teen), "fjorton": (14, .teen), "femton": (15, .teen),
        "sexton": (16, .teen), "sjutton": (17, .teen), "arton": (18, .teen),
        "nitton": (19, .teen),
        "tjugo": (20, .ten), "trettio": (30, .ten), "fyrtio": (40, .ten),
        "femtio": (50, .ten), "sextio": (60, .ten), "sjuttio": (70, .ten),
        "åttio": (80, .ten), "nittio": (90, .ten),
        "hundra": (100, .hundred),
    ]

    /// Swedish numeral morphemes sorted by length descending, for longest-prefix
    /// decomposition of compound tokens ("hundratrettionio" → 100,30,9 = 139;
    /// "etthundrafyrtiotre" → 1,100,40,3 = 143).
    private static let swedishMorphemes: [(String, Int, NumKind)] = {
        var list = swedishWords.map { ($0.key, $0.value.0, $0.value.1) }
        list.sort { $0.0.count > $1.0.count }
        return list
    }()

    /// Consumes a number starting at `from`, returning its value and how many
    /// words it spanned. Digits are the primary path; number words are
    /// best-effort and may span several words ("one forty three" = 143) or one
    /// compound Swedish token ("etthundrafyrtiotre" = 143).
    private static func consumeNumber(
        _ words: [String],
        from start: Int,
        locale: PinVoiceLocale
    ) -> (value: Double, consumed: Int)? {
        // Primary path: a digit token ("143", "4.5", already comma-normalized).
        if let d = parseDigits(words[start]) {
            return (d, 1)
        }
        // Best-effort number-word run.
        var pieces: [(Int, NumKind)] = []
        var j = start
        while j < words.count {
            let w = words[j]
            // Connectors permitted *inside* a run once it has started.
            if (w == "and" || w == "och"), !pieces.isEmpty {
                j += 1
                continue
            }
            // "a hundred" — the article counts as 1 only before "hundred".
            if w == "a" || w == "an" {
                if j + 1 < words.count && words[j + 1] == "hundred" {
                    pieces.append((1, .ones))
                    j += 1
                    continue
                }
                break
            }
            if let parts = numberPieces(w, locale: locale) {
                pieces.append(contentsOf: parts)
                j += 1
                continue
            }
            break
        }
        guard !pieces.isEmpty, let value = compose(pieces) else { return nil }
        return (value, j - start)
    }

    /// A pure digit token → its value. Requires the token to start with a digit
    /// so words never accidentally parse as numbers.
    private static func parseDigits(_ w: String) -> Double? {
        guard let first = w.first, first.isNumber else { return nil }
        return Double(w)
    }

    /// The numeral pieces for a single word, honoring the locale's vocabulary
    /// preference, then falling back to the other language, then to Swedish
    /// compound decomposition.
    private static func numberPieces(_ w: String, locale: PinVoiceLocale) -> [(Int, NumKind)]? {
        let primary = locale == .swedish ? swedishWords : englishWords
        let secondary = locale == .swedish ? englishWords : swedishWords
        if let p = primary[w] { return [p] }
        if let p = secondary[w] { return [p] }
        return decomposeSwedish(w)
    }

    /// Longest-prefix decomposition of a Swedish compound token into numeral
    /// morphemes. Must consume the whole token, else it is not a number.
    /// Requires ≥2 pieces — single words are already handled by the direct map.
    private static func decomposeSwedish(_ w: String) -> [(Int, NumKind)]? {
        var rem = Substring(w)
        var pieces: [(Int, NumKind)] = []
        outer: while !rem.isEmpty {
            for (morpheme, value, kind) in swedishMorphemes where rem.hasPrefix(morpheme) {
                pieces.append((value, kind))
                rem = rem.dropFirst(morpheme.count)
                continue outer
            }
            return nil // stuck — not a Swedish numeral compound.
        }
        return pieces.count >= 2 ? pieces : nil
    }

    /// Composes numeral pieces into a value. Handles the spoken digit-pair style
    /// ("one forty three" = 143, no explicit "hundred") by treating a leading
    /// ones word directly before a tens/teens word as hundreds; otherwise the
    /// standard hundred-chunk accumulation ("one hundred and forty three" = 143).
    private static func compose(_ pieces: [(Int, NumKind)]) -> Double? {
        guard !pieces.isEmpty else { return nil }
        var acc = 0
        var startIndex = 0
        let hasHundred = pieces.contains { $0.1 == .hundred }
        if !hasHundred,
           pieces.count >= 2,
           pieces[0].1 == .ones,
           pieces[1].1 == .ten || pieces[1].1 == .teen {
            acc = pieces[0].0 * 100
            startIndex = 1
        }
        var chunk = 0
        for k in startIndex..<pieces.count {
            let (value, kind) = pieces[k]
            if kind == .hundred {
                if chunk == 0 { chunk = 1 }
                acc += chunk * 100
                chunk = 0
            } else {
                chunk += value
            }
        }
        acc += chunk
        return Double(acc)
    }

    // MARK: - Interpretation

    private static func interpret(_ tokens: [Tok]) -> [PinPhrase] {
        // Pass 1: bind `NUMBER FROM EDGE` clauses; collect the rest.
        var depthFromFrontM: Double?
        var depthFromBackM: Double?          // present ⇒ sheet impossible.
        var lateralFromLeftM: Double?
        var lateralFromRightM: Double?       // present ⇒ no representation.
        var bareNumbers: [Double] = []
        var wordTokens: [Tok] = []

        var i = 0
        while i < tokens.count {
            let t = tokens[i]
            if case let .number(n) = t {
                if i + 2 < tokens.count, tokens[i + 1] == .from, isEdge(tokens[i + 2]) {
                    switch tokens[i + 2] {
                    case .edgeDepth(far: false): depthFromFrontM = n
                    case .edgeDepth(far: true): depthFromBackM = n
                    case .edgeLat(far: false): lateralFromLeftM = n
                    case .edgeLat(far: true): lateralFromRightM = n
                    default: break
                    }
                    i += 3
                    continue
                }
                bareNumbers.append(n)
                i += 1
            } else if t == .from {
                i += 1 // stray FROM — drop.
            } else {
                wordTokens.append(t)
                i += 1
            }
        }

        // Pass 2: resolve remaining word tokens to fractions. A MODIFIER attaches
        // forward to the next edge/position; a POSITION (middle) combines with a
        // following lateral edge ("middle right" = midpoint of middle and far).
        var lateralWordFraction: Double?
        var depthWordFraction: Double?
        var pendingModifier = false
        var pendingMiddle = false

        for t in wordTokens {
            switch t {
            case .modifier:
                pendingModifier = true
            case .position:
                pendingMiddle = true
            case let .edgeLat(far):
                lateralWordFraction = lateralFraction(
                    far: far, modifier: pendingModifier, middle: pendingMiddle
                )
                pendingModifier = false
                pendingMiddle = false
            case let .edgeDepth(far):
                // A dangling "middle" before a depth word was the lateral centre.
                if pendingMiddle, lateralWordFraction == nil {
                    lateralWordFraction = PinWordFractions.middle
                }
                pendingMiddle = false
                depthWordFraction = pendingModifier
                    ? (far ? PinWordFractions.farEdge : PinWordFractions.nearEdge)
                    : (far ? PinWordFractions.far : PinWordFractions.near)
                pendingModifier = false
            case .number, .from:
                break // not present in wordTokens.
            }
        }
        // A lone "middle" (no edge) is a lateral centre for visual mode.
        if pendingMiddle, lateralWordFraction == nil {
            lateralWordFraction = PinWordFractions.middle
        }

        // Pass 3: assemble ranked candidates.
        var candidates: [PinPhrase] = []

        // Rule 1 — sheet: two numeric clauses, front + left only.
        if let depth = depthFromFrontM, let lateral = lateralFromLeftM {
            candidates.append(.sheet(depthFromFrontM: depth, lateralFromLeftM: lateral))
        }

        // Rule 2 — hybrid: front depth number + a *word* lateral.
        if let depth = depthFromFrontM,
           let lat = lateralWordFraction,
           lateralFromLeftM == nil, lateralFromRightM == nil {
            candidates.append(.hybrid(depthFromFrontM: depth, lateralFraction: lat))
        }

        // Front depth number with no lateral at all → default lateral to middle.
        // (Not in the spec table, but "N from front" alone is a sensible pin.)
        if let depth = depthFromFrontM,
           lateralFromLeftM == nil, lateralFromRightM == nil, lateralWordFraction == nil {
            candidates.append(.hybrid(depthFromFrontM: depth, lateralFraction: PinWordFractions.middle))
        }

        // Rule 3 — laser: bare number ≥ 40 + optional side word.
        let largeBare = bareNumbers.filter { $0 >= 40 }
        for n in largeBare {
            candidates.append(.laser(distanceM: n, lateralFraction: lateralWordFraction))
        }

        // Rule 4 — visual: no numbers, only word fractions.
        let hasAnyNumber = !bareNumbers.isEmpty
            || depthFromFrontM != nil || depthFromBackM != nil
            || lateralFromLeftM != nil || lateralFromRightM != nil
        if !hasAnyNumber, depthWordFraction != nil || lateralWordFraction != nil {
            candidates.append(.visual(
                depthFraction: depthWordFraction ?? PinWordFractions.middle,
                lateralFraction: lateralWordFraction ?? PinWordFractions.middle
            ))
        }

        // Rule 5 — a bare number < 40 with no context is an implausible laser;
        // rank it AFTER any word-based reading.
        let smallBare = bareNumbers.filter { $0 < 40 }
        for n in smallBare {
            candidates.append(.laser(distanceM: n, lateralFraction: lateralWordFraction))
        }

        // Note: `depthFromBackM` or `lateralFromRightM` numeric clauses are
        // intentionally not convertible here (see type doc) — they contribute no
        // candidate, which is the honest "no representation" outcome.

        return candidates
    }

    /// A word-derived lateral fraction. Modifier pushes to the extreme edge;
    /// a leading "middle" gives the midpoint of centre and the named side.
    private static func lateralFraction(far: Bool, modifier: Bool, middle: Bool) -> Double {
        if modifier {
            return far ? PinWordFractions.farEdge : PinWordFractions.nearEdge
        }
        if middle {
            return far
                ? (PinWordFractions.middle + PinWordFractions.far) / 2
                : (PinWordFractions.middle + PinWordFractions.near) / 2
        }
        return far ? PinWordFractions.far : PinWordFractions.near
    }

    private static func isEdge(_ t: Tok) -> Bool {
        switch t {
        case .edgeDepth, .edgeLat: return true
        default: return false
        }
    }
}
