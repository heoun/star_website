/* Star Real Estate -- the page runtime for every page but the home:
   the nav sheet (on the class names the pages already use), reveals via
   IntersectionObserver, and the measured-city strip painted once from
   the baked plate. No libraries. */
(function () {
  document.documentElement.classList.add("js");
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    document.documentElement.classList.add("reduced");
    document.querySelectorAll("video[autoplay]").forEach(function (v) {
      v.removeAttribute("autoplay");
      try { v.pause(); } catch (e) {}
    });
  }

  var menuToggle = document.querySelector(".menu-toggle");
  var mobileNav = document.querySelector(".mobile-nav");
  var closeButton = document.querySelector(".close-nav");

  function openNav() {
    mobileNav && mobileNav.classList.add("open");
    mobileNav && mobileNav.setAttribute("aria-hidden", "false");
    menuToggle && menuToggle.setAttribute("aria-expanded", "true");
    document.body.classList.add("nav-open");
  }
  function closeNav() {
    mobileNav && mobileNav.classList.remove("open");
    mobileNav && mobileNav.setAttribute("aria-hidden", "true");
    menuToggle && menuToggle.setAttribute("aria-expanded", "false");
    document.body.classList.remove("nav-open");
  }
  menuToggle && menuToggle.addEventListener("click", function () {
    if (mobileNav && mobileNav.classList.contains("open")) closeNav();
    else openNav();
  });
  closeButton && closeButton.addEventListener("click", closeNav);
  mobileNav && mobileNav.addEventListener("click", function (event) {
    if (event.target === mobileNav) closeNav();
  });
  document.querySelectorAll(".mobile-sheet a").forEach(function (link) {
    link.addEventListener("click", closeNav);
  });

  var els = document.querySelectorAll("[data-reg]");
  if ("IntersectionObserver" in window && !document.documentElement.classList.contains("reduced")) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) { entry.target.classList.add("in"); io.unobserve(entry.target); }
      });
    }, { rootMargin: "0px 0px -8% 0px" });
    els.forEach(function (el) { io.observe(el); });
  } else els.forEach(function (el) { el.classList.add("in"); });

  /* the measured city along the floor of the shelf: the same baked
     plate the home page reads, drawn once on a 2D canvas */
  var cv = document.querySelector("canvas.cityfoot");
  if (!cv || !window.B64_SKYPLATE) return;
  var img = new Image();
  img.onload = function () {
    var gw = img.naturalWidth, gh = img.naturalHeight;
    var oc = document.createElement("canvas"); oc.width = gw; oc.height = gh;
    var o = oc.getContext("2d", { willReadFrequently: true });
    o.drawImage(img, 0, 0);
    var v = o.getImageData(0, 0, gw, gh).data;
    function recede(t) {
      var n = [9, 12, 30], m = [41, 49, 162], f = [152, 160, 213];
      var a = Math.min(t / 0.55, 1), b = Math.pow(Math.max(0, Math.min(1, (t - 0.55) / 0.45)), 0.9);
      var out = [0, 0, 0];
      for (var i = 0; i < 3; i++) { var lo = n[i] + (m[i] - n[i]) * a; out[i] = Math.round(lo + (f[i] - lo) * b); }
      return "rgb(" + out.join(",") + ")";
    }
    function draw() {
      var host = cv.parentElement, W = host.clientWidth;
      if (!W) return;
      var S = W * (W < 860 ? 0.98 : 0.72);
      var capH = Math.min(258, Math.round(innerHeight * 0.29));
      if (0.239 * S > capH) S = capH / 0.239;
      var cell = S / gw, H = Math.round(gh * cell) + 10;
      var DPR = Math.min(devicePixelRatio || 1, 2);
      cv.style.height = H + "px";
      cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
      var c = cv.getContext("2d");
      c.setTransform(DPR, 0, 0, DPR, 0, 0);
      c.clearRect(0, 0, W, H);
      var pitch = 2, x0 = Math.round((W - S) / 2);
      var cols = Math.floor(S / pitch), rows = Math.floor(gh * cell / pitch);
      for (var j = 0; j <= rows; j++) {
        var r1 = gh - Math.round(j * pitch / cell), r0 = Math.max(0, gh - Math.round((j + 1) * pitch / cell));
        if (r1 <= 0) break;
        for (var i = 0; i <= cols; i++) {
          var c0 = Math.round(i * pitch / cell), c1 = Math.min(gw, Math.round((i + 1) * pitch / cell));
          if (c0 >= gw) break;
          var sum = 0, hit = 0, area = (r1 - r0) * (c1 - c0) || 1;
          for (var r = r0; r < r1; r++) { var row = r * gw;
            for (var q = c0; q < c1; q++) { var val = v[(row + q) * 4]; if (val) { sum += val; hit++; } } }
          if (!hit || hit < area * 0.34) continue;
          var t = (sum / hit - 1) / 254;
          c.globalAlpha = 0.5 + 0.5 * Math.pow(Math.max(1 - t, 0.002), 1.1);
          c.fillStyle = recede(t);
          var d = pitch * (0.94 - 0.26 * t);
          c.fillRect(x0 + i * pitch - d / 2, H - 6 - j * pitch - d / 2, d, d);
        }
      }
      c.globalAlpha = 1;
    }
    draw();
    var rz = null;
    addEventListener("resize", function () {
      if (rz !== null) return;
      rz = requestAnimationFrame(function () { rz = null; draw(); });
    });
  };
  img.src = window.B64_SKYPLATE;
})();
