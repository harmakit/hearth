const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const feedbackPulses = new Map();

reducedMotion.addEventListener('change', () => {
  if (reducedMotion.matches) for (const pulse of feedbackPulses.values()) pulse.cancel();
});

export function pulseFeedback(element, failed = false) {
  feedbackPulses.get(element)?.cancel();
  if (reducedMotion.matches) return;

  const tone = failed ? 'var(--blocked)' : 'var(--green)';
  const tint = `color-mix(in srgb, ${tone} 20%, var(--surface))`;
  const pulse = element.animate([{ backgroundColor: tint, offset: 0 }], {
    duration: 620, easing: 'ease-out',
  });
  feedbackPulses.set(element, pulse);
  const release = () => {
    if (feedbackPulses.get(element) === pulse) feedbackPulses.delete(element);
  };
  pulse.finished.then(release, release);
}
