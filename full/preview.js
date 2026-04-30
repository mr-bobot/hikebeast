// Shared script for preview chapter pages
(function () {
  // Exclude hidden slides (e.g. the unused mini-grid card) from the count
  const slides = Array.from(document.querySelectorAll('.viewer .slide'))
    .filter((el) => getComputedStyle(el).display !== 'none');
  if (!slides.length) return;

  const crumbCur = document.getElementById('crumbCur');
  const crumbTotal = document.getElementById('crumbTotal');
  if (crumbTotal) crumbTotal.textContent = slides.length;

  // Track which card is most visible → update crumb
  if (crumbCur && 'IntersectionObserver' in window) {
    let visibility = new Map();
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => visibility.set(e.target, e.intersectionRatio));
      let bestIdx = 0;
      let bestRatio = -1;
      slides.forEach((s, i) => {
        const r = visibility.get(s) || 0;
        if (r > bestRatio) { bestRatio = r; bestIdx = i; }
      });
      crumbCur.textContent = bestIdx + 1;
    }, { threshold: [0.1, 0.3, 0.5, 0.7, 0.9] });
    slides.forEach(s => io.observe(s));
  }

  // Click a spot card on the grid → smooth-scroll to its detail card below
  document.querySelectorAll('[data-jump]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const target = document.getElementById(el.getAttribute('data-jump'));
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
})();
