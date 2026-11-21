// Async Promise Bridge to the dedicated 62-indicator WebAssembly Web Worker

export class RiskEngineClient {
  constructor() {
    this.worker = new Worker(new URL("./engine.worker.js", import.meta.url), { type: "module" });
    this.seq = 1;
    this.pending = new Map();
    this.worker.onmessage = (ev) => {
      const { id, ok, result, error } = ev.data;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (ok) entry.resolve(result);
      else entry.reject(new Error(error));
    };
    this.worker.onerror = (err) => {
      console.error("[Risk WASM Worker Error]", err);
    };
  }

  _call(type, payload) {
    return new Promise((resolve, reject) => {
      const id = this.seq++;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, payload });
    });
  }

  loadBars(bars) {
    return this._call("LOAD_BARS", { bars });
  }

  evaluate(payload) {
    return this._call("EVALUATE", payload);
  }

  evaluateTournament(payload) {
    return this._call("EVALUATE_TOURNAMENT", payload);
  }

  previewDraft(payload) {
    return this._call("PREVIEW_DRAFT", payload);
  }

  snapshotIndicators(catalogDefaults) {
    return this._call("SNAPSHOT_INDICATORS", { catalogDefaults });
  }
}
