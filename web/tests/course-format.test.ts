import { test, expect } from 'bun:test';
import { timeAgo, formatLength, formatPar, mappedPct, mappedLabel, pctLabel } from '../src/courses/course-format';

const EMDASH = '—';
const THIN_SPACE = ' '; // thin space, matches course-format.ts

// ── timeAgo ─────────────────────────────────────────────────────────────

test('timeAgo: under an hour reads "Just added"', () => {
    const now = Date.parse('2026-07-12T12:00:00Z');
    expect(timeAgo('2026-07-12T11:59:00Z', now)).toBe('Just added');
    expect(timeAgo('2026-07-12T12:00:00Z', now)).toBe('Just added'); // exactly now
});

test('timeAgo: hours bucket', () => {
    const now = Date.parse('2026-07-12T12:00:00Z');
    expect(timeAgo('2026-07-12T09:00:00Z', now)).toBe('3h ago');
    expect(timeAgo('2026-07-11T13:00:00Z', now)).toBe('23h ago');
});

test('timeAgo: days bucket', () => {
    const now = Date.parse('2026-07-12T12:00:00Z');
    expect(timeAgo('2026-07-11T12:00:00Z', now)).toBe('1d ago');
    expect(timeAgo('2026-07-06T12:00:00Z', now)).toBe('6d ago');
});

test('timeAgo: weeks bucket', () => {
    const now = Date.parse('2026-07-12T12:00:00Z');
    expect(timeAgo('2026-07-05T12:00:00Z', now)).toBe('1w ago');
    expect(timeAgo('2026-06-14T12:00:00Z', now)).toBe('4w ago');
});

test('timeAgo: months bucket, minimum 1mo', () => {
    const now = Date.parse('2026-07-12T12:00:00Z');
    expect(timeAgo('2026-06-01T12:00:00Z', now)).toBe('1mo ago');
    expect(timeAgo('2025-09-01T12:00:00Z', now)).toBe('10mo ago');
});

test('timeAgo: years bucket, minimum 1y', () => {
    const now = Date.parse('2026-07-12T12:00:00Z');
    expect(timeAgo('2025-06-01T12:00:00Z', now)).toBe('1y ago');
    expect(timeAgo('2020-01-01T12:00:00Z', now)).toBe('6y ago');
});

test('timeAgo: unparseable input falls back to EMDASH', () => {
    expect(timeAgo('not-a-date')).toBe(EMDASH);
    expect(timeAgo('')).toBe(EMDASH);
});

// ── formatLength ────────────────────────────────────────────────────────

test('formatLength: thin-space thousands grouping', () => {
    expect(formatLength(5842)).toBe(`5${THIN_SPACE}842${THIN_SPACE}m`);
    expect(formatLength(12345)).toBe(`12${THIN_SPACE}345${THIN_SPACE}m`);
});

test('formatLength: sub-1000 has no grouping separator', () => {
    expect(formatLength(842)).toBe(`842${THIN_SPACE}m`);
});

test('formatLength: 0/negative/absent renders EMDASH', () => {
    expect(formatLength(0)).toBe(EMDASH);
    expect(formatLength(-5)).toBe(EMDASH);
    expect(formatLength(NaN)).toBe(EMDASH);
});

test('formatLength: rounds fractional metres', () => {
    expect(formatLength(5841.6)).toBe(`5${THIN_SPACE}842${THIN_SPACE}m`);
});

// ── formatPar ───────────────────────────────────────────────────────────

test('formatPar: positive par renders as string, 0/negative renders EMDASH', () => {
    expect(formatPar(72)).toBe('72');
    expect(formatPar(0)).toBe(EMDASH);
    expect(formatPar(-1)).toBe(EMDASH);
});

// ── mappedPct / mappedLabel / pctLabel — 0-hole edge cases ────────────────

test('mappedPct: 0 holes yields 0 (no divide-by-zero)', () => {
    expect(mappedPct(0, 0)).toBe(0);
});

test('mappedPct: normal fraction rounds to nearest integer percent', () => {
    expect(mappedPct(1, 3)).toBe(33);
    expect(mappedPct(9, 18)).toBe(50);
    expect(mappedPct(18, 18)).toBe(100);
});

test('mappedLabel: 0 holes reads "Not started"', () => {
    expect(mappedLabel(0, 0)).toBe('Not started');
});

test('mappedLabel: 0 mapped of N holes reads "0 of N mapped"', () => {
    expect(mappedLabel(0, 18)).toBe('0 of 18 mapped');
});

test('mappedLabel: fully mapped reads "Fully mapped"', () => {
    expect(mappedLabel(18, 18)).toBe('Fully mapped');
    expect(mappedLabel(19, 18)).toBe('Fully mapped'); // over-mapped clamps to "Fully mapped" too
});

test('mappedLabel: partial reads "N of M mapped"', () => {
    expect(mappedLabel(5, 18)).toBe('5 of 18 mapped');
});

test('pctLabel: 0 holes renders EMDASH (not "0%")', () => {
    expect(pctLabel(0, 0)).toBe(EMDASH);
});

test('pctLabel: normal case renders "N%"', () => {
    expect(pctLabel(9, 18)).toBe('50%');
    expect(pctLabel(0, 18)).toBe('0%');
});
