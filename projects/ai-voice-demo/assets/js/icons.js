/* Icon system
 *
 * - [data-svg="name"]    → inlines /assets/icons/{name}.svg (themed via currentColor)
 * - [data-lottie="name"] → loads /assets/lottie/{name}.json with lottie-web; plays on hover
 * - [data-icon="name"]   → inline SVG from registry (special one-offs)
 */

const SVG_BASE = "./assets/icons/";
const LOTTIE_BASE = "./assets/lottie/";

const svgCache = new Map();

async function fetchSvg(name) {
  if (svgCache.has(name)) return svgCache.get(name);
  const res = await fetch(`${SVG_BASE}${name}.svg`);
  let txt = await res.text();
  // Force currentColor on any fills/strokes that aren't "none"
  txt = txt
    .replace(/fill="(?!none|currentColor|"\s*)([^"]+)"/g, 'fill="currentColor"')
    .replace(/stroke="(?!none|currentColor|"\s*)([^"]+)"/g, 'stroke="currentColor"');
  svgCache.set(name, txt);
  return txt;
}

export async function hydrateSvg(root = document) {
  const hosts = root.querySelectorAll("[data-svg]");
  await Promise.all(
    [...hosts].map(async (el) => {
      const name = el.dataset.svg;
      if (!name) return;
      try {
        el.innerHTML = await fetchSvg(name);
      } catch (e) {
        console.warn("svg load failed:", name, e);
      }
    })
  );
}

const lottieAnims = new WeakMap();

export function hydrateLottie(root = document) {
  if (typeof window.lottie === "undefined") return;
  const hosts = root.querySelectorAll("[data-lottie]");
  hosts.forEach((el) => {
    if (lottieAnims.has(el)) return;
    const name = el.dataset.lottie;
    const anim = window.lottie.loadAnimation({
      container: el,
      renderer: "svg",
      loop: false,
      autoplay: false,
      path: `${LOTTIE_BASE}${name}.json`,
    });
    lottieAnims.set(el, anim);

    const btn = el.closest("button, a, [data-hover-target]");
    const target = btn || el;
    const isActive = () => btn && btn.classList.contains("is-active");

    anim.addEventListener("DOMLoaded", () => {
      if (isActive()) anim.goToAndStop(anim.totalFrames - 1, true);
    });

    target.addEventListener("mouseenter", () => anim.goToAndPlay(0, true));
    target.addEventListener("mouseleave", () => {
      if (isActive()) anim.goToAndStop(anim.totalFrames - 1, true);
      else anim.goToAndStop(0, true);
    });
  });
}

export function setLottieActive(el, active) {
  const anim = lottieAnims.get(el);
  if (!anim) return;
  if (active) anim.goToAndStop(anim.totalFrames - 1, true);
  else anim.goToAndStop(0, true);
}

export function getLottieAnim(el) {
  return lottieAnims.get(el);
}

/* Special-case inline SVGs (not in the SN library, or need theming variants) */
export const iconRegistry = {
  "arrow-up-right": `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 14 14 6M7.5 6H14v6.5"/></svg>`,
  "chevron-left": `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m12.5 5-5 5 5 5"/></svg>`,
  "magnifying-glass": `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="9" r="5.5"/><path d="m13 13 4 4"/></svg>`,
  "tree": `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="3.5" r="1.75"/><circle cx="4" cy="14.5" r="1.75"/><circle cx="10" cy="14.5" r="1.75"/><circle cx="16" cy="14.5" r="1.75"/><path d="M10 5.25v3.5M4 12.75V10h12v2.75M10 8.75v4"/></svg>`,
  "eye": `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>`,
  "fire": `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1.5s3 2.5 3 5.5c0 1.5-1 2-2 2s-1-1-1-2c0 0-2 1.5-2 4 0 2.2 1.8 3.5 4 3.5s4-1.5 4-4c0-3.5-3-5.5-3-9z"/></svg>`,
};

export function hydrateIconRegistry(root = document) {
  root.querySelectorAll("[data-icon]").forEach((el) => {
    const name = el.dataset.icon;
    if (iconRegistry[name]) el.innerHTML = iconRegistry[name];
  });
}

export async function hydrateAll(root = document) {
  hydrateIconRegistry(root);
  hydrateLottie(root);
  await hydrateSvg(root);
}
