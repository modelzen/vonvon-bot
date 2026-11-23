const promo = document.querySelector('.auth-promo');
const frames = [...promo.querySelectorAll('[data-slide]')];
const controls = promo.querySelector('.auth-carousel');
const dots = [...controls.querySelectorAll('button')];
const caption = controls.querySelector('[data-slide-caption]');
let index = 0;
let timer;

function show(next) {
  index = (next + frames.length) % frames.length;
  frames.forEach((frame, i) => { frame.hidden = i !== index; });
  dots.forEach((dot, i) => dot.setAttribute('aria-pressed', String(i === index)));
  caption.textContent = dots[index].getAttribute('aria-label').split('：')[1];
}
function schedule() {
  clearTimeout(timer);
  if (!document.hidden) timer = setTimeout(() => { show(index + 1); schedule(); }, 6500);
}
dots.forEach((dot, i) => {
  dot.addEventListener('click', () => { show(i); schedule(); });
  dot.addEventListener('keydown', event => {
    const next = {ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: frames.length - 1}[event.key];
    if (next === undefined) return;
    event.preventDefault();
    show(next);
    dots[index].focus();
    schedule();
  });
});
controls.hidden = false;
document.addEventListener('visibilitychange', schedule);
window.addEventListener('pagehide', () => clearTimeout(timer));
window.addEventListener('pageshow', schedule);
schedule();
