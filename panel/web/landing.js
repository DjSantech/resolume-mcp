// Página pública: marca, planes y contacto desde el servidor. Sin dependencias.

(function () {
  "use strict";

  var brand = "VisualMaping";
  var whatsapp = "";

  function cop(n) {
    return "$" + String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function wa(text) {
    return "https://wa.me/" + whatsapp + "?text=" + encodeURIComponent(text);
  }

  function getJson(url) {
    return fetch(url, { headers: { Accept: "application/json" } }).then(function (r) {
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    });
  }

  function applyConfig(c) {
    if (c && typeof c.brand === "string" && c.brand.trim()) brand = c.brand.trim();
    whatsapp = c && typeof c.contactWhatsapp === "string" ? c.contactWhatsapp.replace(/\D/g, "") : "";
    document.querySelectorAll("[data-brand]").forEach(function (n) {
      n.textContent = brand;
    });
    document.title = brand + " · Controla Resolume desde el celular";
    if (whatsapp) {
      var link = wa("Hola, quiero saber más de " + brand + " para mis eventos.");
      var cta = document.getElementById("wa-cta");
      cta.href = link;
      cta.target = "_blank";
      cta.rel = "noopener";
      cta.hidden = false;
      document.getElementById("wa-foot-link").href = link;
      document.getElementById("wa-foot").hidden = false;
    }
  }

  function renderPlans(plans) {
    var box = document.getElementById("prices");
    box.textContent = "";
    var trial = plans.filter(function (p) {
      return p.trialDays;
    })[0];
    if (trial) {
      document.querySelectorAll("[data-trial]").forEach(function (n) {
        n.textContent = String(trial.trialDays);
      });
    }
    var paid = plans.filter(function (p) {
      return p.priceCop > 0;
    });
    var featured = paid.length >= 2 ? paid[Math.floor(paid.length / 2)].id : null;
    paid.forEach(function (p) {
      var card = el("article", "price" + (p.id === featured ? " is-featured" : ""));
      if (p.id === featured) card.appendChild(el("span", "price-flag", "El más elegido"));
      card.appendChild(el("h3", "price-name", p.name));
      var amount = el("p", "price-amount");
      amount.appendChild(el("b", null, cop(p.priceCop)));
      amount.appendChild(el("span", null, " / mes"));
      card.appendChild(amount);
      card.appendChild(el("p", "price-pcs", p.maxPcs === 1 ? "1 PC de Resolume" : "Hasta " + p.maxPcs + " PCs de Resolume"));
      var ul = el("ul", "price-feats");
      (p.features || []).forEach(function (f) {
        ul.appendChild(el("li", null, f));
      });
      card.appendChild(ul);
      var a = el("a", "btn btn-block " + (p.id === featured ? "btn-amber" : "btn-line"), "Empieza gratis");
      a.href = "/app#registro";
      card.appendChild(a);
      if (whatsapp) {
        var w = el("a", "price-wa", "Pagar este plan por WhatsApp");
        w.href = wa("Hola, quiero el plan " + p.name + " de " + brand + " (" + cop(p.priceCop) + "/mes).");
        w.target = "_blank";
        w.rel = "noopener";
        card.appendChild(w);
      }
      box.appendChild(card);
    });
    if (!paid.length) box.appendChild(el("p", "prices-loading", "Escríbenos para conocer los planes."));
  }

  getJson("/api/config")
    .then(applyConfig, function () {
      applyConfig(null);
    })
    .then(function () {
      return getJson("/api/plans");
    })
    .then(
      function (plans) {
        renderPlans(Array.isArray(plans) ? plans : []);
      },
      function () {
        var box = document.getElementById("prices");
        box.textContent = "";
        box.appendChild(el("p", "prices-loading", "No se pudieron cargar los precios. Recarga la página."));
      },
    );
})();
