// Wyciąga ID filmu z dowolnego tekstu (link z „Udostępnij”, youtu.be, shorts, m.youtube…).
export function findVideoId(text) {
  if (!text) return null;
  const patterns = [
    /youtu\.be\/([\w-]{11})/,
    /youtube\.com\/(?:shorts|live|embed)\/([\w-]{11})/,
    /youtube\.com\/.*[?&]v=([\w-]{11})/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1];
  }
  return /^[\w-]{11}$/.test(text.trim()) ? text.trim() : null;
}

export const watchUrl = id => `https://www.youtube.com/watch?v=${id}`;
export const thumbUrl = id => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
export const appUrlAt = (id, t) => `https://youtu.be/${id}?t=${Math.max(0, Math.floor(t))}`;

export function embedUrl(id, t) {
  const start = Math.max(0, Math.floor(t) - 1);
  const params = new URLSearchParams({ start, end: start + 8, autoplay: 1, playsinline: 1, rel: 0 });
  return `https://www.youtube-nocookie.com/embed/${id}?${params}`;
}

export function formatTime(t) {
  const s = Math.max(0, Math.floor(t));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
