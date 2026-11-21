import { INDICATOR_BY_ID, INDICATOR_CATALOG, INDICATOR_CATEGORIES } from "../data/indicators.js";

function esc(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

const MODE_TIPS = {
  0: "Strength: smooth continuous score (-100% to +100%) weighted into conviction.",
  1: "Trigger: binary TRUE/FALSE vote firing only past threshold.",
  2: "Veto Filter: macro regime gate that dampens opposing signals.",
};

export function renderStrategyBuilder(container, {
  visible = true,
  activeStrategyId,
  allStrategies,
  isEnsembleMode,
  rules,
  thresholds,
  onSelectStrategy,
  onUpdateRule,
  onRemoveRule,
  onOpenCatalog,
  onSaveAsNew,
  onOpenArena,
  onUpdateThresholds,
}) {
  if (!visible) {
    container.innerHTML = "";
    return;
  }

  if (isEnsembleMode) {
    container.innerHTML = `
      <div class="composer-card">
        <div class="section-mini-head">
          <span>META-CONSENSUS ENSEMBLE MODE</span>
          <button class="btn-primary-sm" id="editInArenaBtn">Strategy Arena</button>
        </div>
        <p class="muted-sm" style="margin:0 0 10px">
          You are viewing a live cross-strategy Meta-Ensemble. Switch to any individual strategy (or create one) to edit indicator weights and parameters.
        </p>
        <div class="thresh-grid">
          <label><span>Strong Buy ≥</span><input type="number" class="mono" data-th="strongBuy" value="${thresholds.strongBuy}" min="25" max="95" /></label>
          <label><span>Buy ≥</span><input type="number" class="mono" data-th="buy" value="${thresholds.buy}" min="5" max="70" /></label>
          <label><span>Sell ≤</span><input type="number" class="mono" data-th="sell" value="${thresholds.sell}" min="-70" max="-5" /></label>
          <label><span>Strong Sell ≤</span><input type="number" class="mono" data-th="strongSell" value="${thresholds.strongSell}" min="-95" max="-25" /></label>
        </div>
      </div>
    `;
    container.querySelector("#editInArenaBtn")?.addEventListener("click", () => onOpenArena?.());
    container.querySelectorAll("[data-th]").forEach((inp) =>
      inp.addEventListener("change", () => onUpdateThresholds?.({ ...thresholds, [inp.dataset.th]: Number(inp.value) }))
    );
    return;
  }

  const ruleCards = rules
    .map((r) => {
      const meta = INDICATOR_BY_ID.get(r.indicatorId);
      if (!meta) return "";
      const paramInputs = meta.params
        .map(
          (p) => `
          <label class="param-field" title="Range: ${p.min} to ${p.max}">
            <span>${esc(p.label)} <em class="muted" style="font-style:normal;font-size:9px">(${p.min}–${p.max})</em></span>
            <input
              type="number"
              class="mono"
              data-rule-param="${r.uid}:${p.key}"
              value="${r.params[p.key]}"
              min="${p.min}"
              max="${p.max}"
              step="${p.step}"
            />
          </label>
        `
        )
        .join("");

      return `
        <div class="rule-card ${r.enabled ? "" : "disabled"}" data-rule-uid="${r.uid}">
          <div class="rule-card-head">
            <label class="rule-toggle">
              <input type="checkbox" data-rule-enable="${r.uid}" ${r.enabled ? "checked" : ""} />
              <span class="rule-title">${esc(meta.shortName)}</span>
            </label>
            <span class="cat-badge cat-${meta.category}">${meta.category}</span>
            <div class="rule-head-actions">
              ${
                meta.placement === "overlay"
                  ? `<button class="icon-btn ${r.showOnChart ? "active" : ""}" data-rule-chart="${r.uid}" title="Toggle chart overlay">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    </button>`
                  : ""
              }
              <button class="icon-btn danger" data-rule-remove="${r.uid}" title="Remove indicator">✕</button>
            </div>
          </div>

          <div class="rule-controls-row">
            <div class="weight-control">
              <span class="ctrl-lbl">Weight <strong class="mono">${Number(r.weight).toFixed(1)}x</strong></span>
              <input type="range" min="0" max="5" step="0.1" value="${r.weight}" data-rule-weight="${r.uid}" />
            </div>

            <select class="mini-select" data-rule-mode="${r.uid}" title="${MODE_TIPS[r.mode] || ""}">
              <option value="0" ${r.mode === 0 ? "selected" : ""}>Strength</option>
              <option value="1" ${r.mode === 1 ? "selected" : ""}>Trigger</option>
              <option value="2" ${r.mode === 2 ? "selected" : ""}>Veto Gate</option>
            </select>

            <button class="chip-toggle ${r.invert ? "active invert-on" : ""}" data-rule-invert="${r.uid}" title="Flip bullish/bearish polarity (e.g. mean-reversion ↔ breakout)">
              ${r.invert ? "⇄ INV ON" : "⇄ Invert"}
            </button>
          </div>

          <div class="rule-params-row">${paramInputs}</div>
        </div>
      `;
    })
    .join("");

  container.innerHTML = `
    <div class="composer-card">
      <div class="section-mini-head">
        <span>EDIT STRATEGY RULES</span>
        <div style="display:flex;gap:6px">
          <button class="btn-ghost-xs" id="saveAsStratBtn" title="Save rules as a reusable strategy on the Leaderboard">Save As</button>
          <button class="btn-add-ind" id="openCatalogBtn">+ Add (${INDICATOR_CATALOG.length})</button>
        </div>
      </div>

      <details class="thresh-drawer">
        <summary>
          <span>Decision Cutoffs</span>
          <span class="mono muted thresh-summary-pills">
            <span class="nowrap">Strong Buy ≥ ${thresholds.strongBuy}</span> ·
            <span class="nowrap">Buy ≥ ${thresholds.buy}</span> ·
            <span class="nowrap">Sell ≤ ${thresholds.sell}</span> ·
            <span class="nowrap">Strong Sell ≤ ${thresholds.strongSell}</span>
          </span>
        </summary>
        <div class="thresh-grid">
          <label><span>Strong Buy ≥</span><input type="number" class="mono" data-th="strongBuy" value="${thresholds.strongBuy}" min="25" max="95" step="1" /></label>
          <label><span>Buy ≥</span><input type="number" class="mono" data-th="buy" value="${thresholds.buy}" min="5" max="70" step="1" /></label>
          <label><span>Sell ≤</span><input type="number" class="mono" data-th="sell" value="${thresholds.sell}" min="-70" max="-5" step="1" /></label>
          <label><span>Strong Sell ≤</span><input type="number" class="mono" data-th="strongSell" value="${thresholds.strongSell}" min="-95" max="-25" step="1" /></label>
        </div>
      </details>

      <div class="rules-stack">${ruleCards}</div>
    </div>
  `;

  container.querySelector("#openCatalogBtn")?.addEventListener("click", () => onOpenCatalog?.());
  container.querySelector("#saveAsStratBtn")?.addEventListener("click", () => onSaveAsNew?.());
  container.querySelectorAll("[data-th]").forEach((inp) =>
    inp.addEventListener("change", () => onUpdateThresholds?.({ ...thresholds, [inp.dataset.th]: Number(inp.value) }))
  );
  container.querySelectorAll("[data-rule-enable]").forEach((cb) =>
    cb.addEventListener("change", () => onUpdateRule?.(cb.dataset.ruleEnable, { enabled: cb.checked }))
  );
  container.querySelectorAll("[data-rule-chart]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const rule = rules.find((r) => r.uid === btn.dataset.ruleChart);
      if (rule) onUpdateRule?.(rule.uid, { showOnChart: !rule.showOnChart });
    })
  );
  container.querySelectorAll("[data-rule-remove]").forEach((btn) =>
    btn.addEventListener("click", () => onRemoveRule?.(btn.dataset.ruleRemove))
  );
  container.querySelectorAll("[data-rule-weight]").forEach((rng) => {
    rng.addEventListener("input", () => {
      const lbl = rng.previousElementSibling?.querySelector("strong");
      if (lbl) lbl.textContent = `${Number(rng.value).toFixed(1)}x`;
    });
    rng.addEventListener("change", () => onUpdateRule?.(rng.dataset.ruleWeight, { weight: Number(rng.value) }));
  });
  container.querySelectorAll("[data-rule-mode]").forEach((sel) =>
    sel.addEventListener("change", () => onUpdateRule?.(sel.dataset.ruleMode, { mode: Number(sel.value) }))
  );
  container.querySelectorAll("[data-rule-invert]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const rule = rules.find((r) => r.uid === btn.dataset.ruleInvert);
      if (rule) onUpdateRule?.(rule.uid, { invert: !rule.invert });
    })
  );
  container.querySelectorAll("[data-rule-param]").forEach((inp) =>
    inp.addEventListener("change", () => {
      const [uid, key] = inp.dataset.ruleParam.split(":");
      const rule = rules.find((r) => r.uid === uid);
      if (!rule) return;
      onUpdateRule?.(uid, { params: { ...rule.params, [key]: Number(inp.value) } });
    })
  );
}

export function openIndicatorCatalogModal({ activeKeys, liveSignals = {}, onAddIndicator }) {
  const existing = document.getElementById("indicatorCatalogModal");
  if (existing) existing.remove();

  let selectedCat = "all";
  let query = "";

  const overlay = document.createElement("div");
  overlay.id = "indicatorCatalogModal";
  overlay.className = "modal-backdrop";

  const renderInner = () => {
    const filtered = INDICATOR_CATALOG.filter((item) => {
      if (selectedCat !== "all" && item.category !== selectedCat) return false;
      if (query) {
        const q = query.toLowerCase();
        return (
          item.name.toLowerCase().includes(q) ||
          item.shortName.toLowerCase().includes(q) ||
          item.description.toLowerCase().includes(q)
        );
      }
      return true;
    });

    const catPills = INDICATOR_CATEGORIES.map(
      (c) => `<button class="pill-btn ${selectedCat === c.id ? "active" : ""}" data-cat="${c.id}">${c.label}</button>`
    ).join("");

    const cards = filtered
      .map((item) => {
        const count = activeKeys.filter((k) => k === item.key).length;
        const sig = liveSignals[item.key];
        const sigDot =
          sig === undefined
            ? ""
            : sig > 0.15
            ? `<span class="signal-pill bull">▲ ${Math.round(sig * 100)}%</span>`
            : sig < -0.15
            ? `<span class="signal-pill bear">▼ ${Math.round(Math.abs(sig) * 100)}%</span>`
            : `<span class="signal-pill flat">—</span>`;
        return `
          <div class="catalog-item">
            <div class="catalog-item-top">
              <div>
                <div class="catalog-name">${esc(item.name)} <span class="cat-badge cat-${item.category}">${item.category}</span> ${sigDot}</div>
                <div class="catalog-desc">${esc(item.description)}</div>
              </div>
              <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
                ${count > 0 ? `<span class="added-chip">✓ Added ×${count}</span>` : ""}
                <button class="btn-primary-sm" data-add-key="${item.key}">${count > 0 ? "+ Add Another" : "+ Add"}</button>
              </div>
            </div>
            <div class="catalog-rules-meta">
              <span class="pos">▲ ${esc(item.bullRule)}</span>
              <span class="neg">▼ ${esc(item.bearRule)}</span>
            </div>
          </div>
        `;
      })
      .join("");

    overlay.innerHTML = `
      <div class="modal-sheet">
        <div class="modal-header">
          <div>
            <h3>Indicator Library <span class="mono muted">(${INDICATOR_CATALOG.length} WASM-Compiled Indicators)</span></h3>
            <p class="muted-sm">Each card shows the live signal on the current chart so you can pick complementary or contrarian factors. Press Esc to close.</p>
          </div>
          <button class="icon-btn" id="closeCatalogBtn" aria-label="Close">✕</button>
        </div>

        <div class="modal-toolbar">
          <input type="text" id="catalogSearch" class="search-input" placeholder="Search KAMA, Ichimoku, TSI, Klinger, Ulcer, Z-Score, VWAP…" value="${esc(query)}" />
          <div class="cat-pills">${catPills}</div>
        </div>

        <div class="catalog-grid">
          ${cards || `<div class="panel-empty">No indicators match "${esc(query)}"</div>`}
        </div>
      </div>
    `;

    overlay.querySelector("#closeCatalogBtn")?.addEventListener("click", () => overlay.remove());
    overlay.querySelector("#catalogSearch")?.addEventListener("input", (e) => {
      query = e.target.value;
      const pos = e.target.selectionStart;
      renderInner();
      const inp = overlay.querySelector("#catalogSearch");
      inp?.focus();
      inp?.setSelectionRange(pos, pos);
    });
    overlay.querySelectorAll("[data-cat]").forEach((b) =>
      b.addEventListener("click", () => { selectedCat = b.dataset.cat; renderInner(); })
    );
    overlay.querySelectorAll("[data-add-key]").forEach((b) =>
      b.addEventListener("click", () => {
        onAddIndicator?.(b.dataset.addKey);
        activeKeys.push(b.dataset.addKey);
        renderInner();
      })
    );
  };

  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  renderInner();
  document.body.appendChild(overlay);
  overlay.querySelector("#catalogSearch")?.focus();
}
