// Powtórki w algorytmie FSRS (ts-fsrs). W bazie daty trzymamy jako liczby (ms).
import { fsrs, generatorParameters, createEmptyCard, Rating } from '../vendor/ts-fsrs.mjs';

const scheduler = fsrs(generatorParameters({ enable_fuzz: true, request_retention: 0.9 }));

export const GRADES = [
  { rating: Rating.Again, label: 'Nie pamiętam', cls: 'again' },
  { rating: Rating.Hard, label: 'Z trudem', cls: 'hard' },
  { rating: Rating.Good, label: 'Pamiętam', cls: 'good' },
];

const toStored = c => ({
  ...c,
  due: +c.due,
  last_review: c.last_review ? +c.last_review : null,
});

const fromStored = s => ({
  ...s,
  due: new Date(s.due),
  last_review: s.last_review ? new Date(s.last_review) : undefined,
});

export function newSrs(now = new Date()) {
  return toStored(createEmptyCard(now));
}

export function grade(srs, rating, now = new Date()) {
  return toStored(scheduler.next(fromStored(srs), now, rating).card);
}

// Podgląd interwału pod przyciskiem, np. „10 min”, „3 dni”.
export function preview(srs, now = new Date()) {
  const all = scheduler.repeat(fromStored(srs), now);
  const out = {};
  for (const g of GRADES) out[g.rating] = formatInterval(+all[g.rating].card.due - +now);
  return out;
}

export function formatInterval(ms) {
  const min = Math.max(1, Math.round(ms / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h`;
  const d = Math.round(h / 24);
  if (d < 31) return d === 1 ? '1 dzień' : `${d} dni`;
  const m = Math.round(d / 30);
  if (m < 12) return `${m} mies.`;
  return `${(d / 365).toFixed(1)} lat`;
}
