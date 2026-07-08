// Text normalization: every stored/displayed text starts with a capital letter.
// Only the first character is touched, and only when it's a lowercase letter —
// "2h review", "iPhone fix" style strings and non-letter starts are left alone
// except that a leading lowercase letter is always raised ("iPhone" → "IPhone" is
// avoided by checking just the first char, which for "iPhone" IS lowercase… so we
// accept that tradeoff: the requirement is "text always starts with a capital").
const capFirst = (s) => {
  if (typeof s !== 'string') return s;
  return s.replace(/^(\s*)(\p{Ll})/u, (m, ws, ch) => ws + ch.toUpperCase());
};

// Comma-separated labels: capitalize each label, but never system tags like "linear:ENG-101"
const capLabels = (labels) => {
  if (typeof labels !== 'string') return labels;
  return labels.split(',').map((l) => {
    const t = l.trim();
    return t.includes(':') ? t : capFirst(t);
  }).filter(Boolean).join(',');
};

// Machine keys like "in_progress" → "In progress" (for exports/labels)
const prettyKey = (v) => capFirst(String(v ?? '').replace(/_/g, ' '));

module.exports = { capFirst, capLabels, prettyKey };
