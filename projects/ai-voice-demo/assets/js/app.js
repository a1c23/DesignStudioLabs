import { hydrateAll, hydrateIconRegistry, hydrateSvg, hydrateLottie, setLottieActive } from "./icons.js";
import { OmnibarController } from "./omnibar.js";

document.addEventListener("DOMContentLoaded", async () => {
  await hydrateAll();

  /* ---- View routing ---- */
  const views = {
    home: document.querySelector('[data-view="home"]'),
    inbox: document.querySelector('[data-view="inbox"]'),
    canvas: document.querySelector('[data-view="canvas"]'),
  };
  const navTargets = document.querySelectorAll("[data-nav]");
  const footerOmnibar = document.querySelector(".omnibar-footer");

  const navIcons = {
    home: document.querySelector('button[data-nav="home"]'),
    inbox: document.querySelector('button[data-nav="inbox"]'),
    canvas: document.querySelector('button[data-nav="canvas"]'),
  };

  function setActiveNav(name) {
    Object.entries(navIcons).forEach(([k, btn]) => {
      if (!btn) return;
      const active = k === name;
      btn.classList.toggle("is-active", active);
      // Swap outline ↔ fill icon variant if specified on the button
      const outlineName = btn.dataset.svgOutline;
      const fillName = btn.dataset.svgFill;
      if (outlineName && fillName) {
        const host = btn.querySelector("[data-svg]");
        if (host) {
          const wanted = active ? fillName : outlineName;
          if (host.dataset.svg !== wanted) {
            host.dataset.svg = wanted;
            hydrateSvg(btn);
          }
        }
      }
      const lottieEl = btn.querySelector("[data-lottie]");
      if (lottieEl) setLottieActive(lottieEl, active);
    });
  }

  let currentView = null;

  function applyView(name) {
    Object.entries(views).forEach(([k, el]) => {
      if (!el) return;
      el.classList.toggle("is-active", k === name);
    });
    const active = views[name];
    if (active) {
      const animated = active.querySelectorAll(".fade-up");
      animated.forEach((el, i) => {
        el.style.animation = "none";
        void el.offsetWidth;
        el.style.animation = "";
        el.style.animationDelay = `${i * 50}ms`;
      });
    }
    setActiveNav(name);
    currentView = name;
  }

  function showView(name) {
    if (currentView === name) return;
    const omni = window.__omnibar;

    // Each view has its own default omnibar state.
    // Orb is overlay-only — not bound to a view.
    const stateForView = {
      home: "omni-hero",
      inbox: "omni-dock",
      canvas: "omni-transcript",
    };
    const isAuxView = (v) => v === "inbox" || v === "canvas";

    // home → aux view (inbox/canvas): hero fades up & out; new state fades in
    if (currentView === "home" && isAuxView(name)) {
      const hero = document.querySelector(".state-omni-hero");
      if (hero) hero.classList.add("is-leaving");
      setTimeout(() => {
        if (hero) hero.classList.remove("is-leaving");
        applyView(name);
        if (omni) omni.setState(stateForView[name], { skipAnim: true });
      }, 220);
      return;
    }

    // aux view → home: current state fades up & out, then hero fades in
    if (isAuxView(currentView) && name === "home") {
      const exitingState = stateForView[currentView];
      const exitingEl = document.querySelector(`.state-${exitingState}`);
      if (exitingEl) exitingEl.classList.add("is-leaving");
      setTimeout(() => {
        if (exitingEl) exitingEl.classList.remove("is-leaving");
        if (omni) omni.setState("omni-hero", { skipAnim: true });
        applyView("home");
      }, 220);
      return;
    }

    // inbox ↔ canvas: swap view and let the state crossfade between
    // dock and transcript via the CSS opacity transitions
    if (isAuxView(currentView) && isAuxView(name)) {
      applyView(name);
      if (omni) omni.setState(stateForView[name]);
      return;
    }

    applyView(name);
  }

  navTargets.forEach((el) => {
    el.addEventListener("click", (e) => {
      const name = el.dataset.nav;
      if (!name || !views[name]) return;
      e.preventDefault();
      showView(name);
    });
  });

  applyView("home");

  // Expose for the omnibar state popover so its buttons can navigate views
  window.__showView = showView;
  window.__currentView = () => currentView;

  /* ---- Omnibar state controller ---- */
  window.__omnibar = new OmnibarController();

  /* ---- Omnibar text carousel ---- */
  const carouselTrack = document.querySelector(".omnibar__carousel-track");
  if (carouselTrack) {
    const items = carouselTrack.querySelectorAll(".omnibar__carousel-item");
    let idx = 0;
    const STEP = 34;
    setInterval(() => {
      idx = (idx + 1) % items.length;
      carouselTrack.style.transform = `translate3d(0, ${-idx * STEP}px, 0)`;
    }, 2600);
  }
});

// Re-hydrate after lottie-web loads if it loads after DOMContentLoaded
window.addEventListener("load", () => {
  hydrateLottie();
});
