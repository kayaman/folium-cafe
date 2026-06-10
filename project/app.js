(() => {
  window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(performance.now()), 0);
  const pdfjs = window.pdfjsLib;
  const PDFJS_VER = "3.11.174";
  const PDFJS_CDN = "https://unpkg.com/pdfjs-dist@" + PDFJS_VER;
  let _workerReady = null;
  function ensureWorker() {
    if (_workerReady) return _workerReady;
    _workerReady = (async () => {
      try {
        const code = await (await fetch(PDFJS_CDN + "/build/pdf.worker.min.js")).text();
        pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(
          new Blob([code], { type: "application/javascript" })
        );
      } catch (e) {
        console.warn("blob worker failed; falling back", e);
        pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_CDN + "/build/pdf.worker.min.js";
      }
    })();
    return _workerReady;
  }
  const $ = (sel) => document.querySelector(sel);
  const el = (id) => document.getElementById(id);
  function toast(msg) {
    const t = el("toast");
    t.textContent = msg;
    t.classList.add("show");
    window.clearTimeout(toast._t);
    toast._t = window.setTimeout(() => t.classList.remove("show"), 2200);
  }
  const DB_NAME = "folio";
  const STORE = "books";
  let _db = null;
  function openDB() {
    return new Promise((resolve, reject) => {
      if (_db) return resolve(_db);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE))
          db.createObjectStore(STORE, { keyPath: "id" });
      };
      req.onsuccess = () => {
        _db = req.result;
        resolve(_db);
      };
      req.onerror = () => reject(req.error);
    });
  }
  function tx(mode) {
    return openDB().then((db) => db.transaction(STORE, mode).objectStore(STORE));
  }
  async function dbPut(b) {
    const store = await tx("readwrite");
    return new Promise((res, rej) => {
      const r = store.put(b);
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    });
  }
  async function dbAll() {
    const store = await tx("readonly");
    return new Promise((res, rej) => {
      const r = store.getAll();
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function dbGet(id) {
    const store = await tx("readonly");
    return new Promise((res, rej) => {
      const r = store.get(id);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function dbDel(id) {
    const store = await tx("readwrite");
    return new Promise((res, rej) => {
      const r = store.delete(id);
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    });
  }
  const LS = {
    user: "folio.user",
    view: "folio.view",
    width: "folio.readerWidth",
    seeded: "folio.seeded2"
  };
  let books = [];
  let viewMode = localStorage.getItem(LS.view) || "shelf";
  function uid() {
    return "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function prettifyName(fn) {
    return fn.replace(/\.pdf$/i, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
  }
  function pct(b) {
    if (b.numPages <= 1) return b.currentPage >= b.numPages ? 100 : 0;
    return Math.round((b.currentPage - 1) / (b.numPages - 1) * 100);
  }
  function relTime(ts) {
    if (!ts) return "Not yet opened";
    const d = Date.now() - ts, m = 6e4, h = m * 60, day = h * 24;
    if (d < m) return "Just now";
    if (d < h) return Math.floor(d / m) + " min ago";
    if (d < day) return Math.floor(d / h) + "h ago";
    if (d < day * 7) return Math.floor(d / day) + "d ago";
    return new Date(ts).toLocaleDateString(void 0, { month: "short", day: "numeric" });
  }
  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  }
  async function loadDoc(data) {
    await ensureWorker();
    return pdfjs.getDocument({
      data: data.slice(0),
      standardFontDataUrl: PDFJS_CDN + "/standard_fonts/",
      cMapUrl: PDFJS_CDN + "/cmaps/",
      cMapPacked: true
    }).promise;
  }
  async function renderCover(doc) {
    try {
      const page = await doc.getPage(1);
      const target = 320;
      const v1 = page.getViewport({ scale: 1 });
      const scale = target / v1.width;
      const vp = page.getViewport({ scale });
      const c = document.createElement("canvas");
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
      return c.toDataURL("image/jpeg", 0.82);
    } catch {
      return null;
    }
  }
  async function ingest(file) {
    try {
      const name = file.name;
      const buf = file.buf ? file.buf : await file.arrayBuffer();
      const doc = await loadDoc(buf);
      let title = prettifyName(name), author = "";
      try {
        const meta = await doc.getMetadata();
        const info = meta && meta.info ? meta.info : {};
        if (info.Title && String(info.Title).trim()) title = String(info.Title).trim();
        if (info.Author && String(info.Author).trim()) author = String(info.Author).trim();
      } catch {
      }
      const cover = await renderCover(doc);
      const book = {
        id: uid(),
        title,
        author,
        fileName: name,
        data: buf,
        numPages: doc.numPages,
        currentPage: 1,
        cover,
        addedAt: Date.now(),
        lastReadAt: 0
      };
      await dbPut(book);
      return book;
    } catch (e) {
      console.error("ingest failed", e);
      toast("Could not read \u201C" + file.name + "\u201D");
      return null;
    }
  }
  async function addFiles(files) {
    const arr = Array.from(files).filter((f) => /pdf$/i.test(f.name) || f.type === "application/pdf");
    if (!arr.length) {
      toast("Please choose PDF files");
      return;
    }
    toast(arr.length === 1 ? "Shelving your book\u2026" : "Shelving " + arr.length + " books\u2026");
    for (const f of arr) {
      const b = await ingest(f);
      if (b) books.unshift(b);
    }
    renderLibrary();
    toast("Added to your library");
  }
  async function seedIfEmpty() {
    if (localStorage.getItem(LS.seeded)) return;
    localStorage.setItem(LS.seeded, "1");
    const samples = [
      { url: "samples/on-the-pleasures-of-reading.pdf", name: "On the Pleasures of Reading.pdf", author: "Folio Editions" },
      { url: "samples/a-field-guide-to-quiet-mornings.pdf", name: "A Field Guide to Quiet Mornings.pdf", author: "Folio Editions" }
    ];
    for (const s of samples) {
      try {
        const res = await fetch(s.url);
        if (!res.ok) continue;
        const buf = await res.arrayBuffer();
        const b = await ingest({ name: s.name, buf });
        if (b) {
          b.author = s.author;
          await dbPut(b);
          books.push(b);
        }
      } catch (e) {
      }
    }
  }
  const ICON = {
    play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 3l14 9-14 9V3z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V6"/></svg>'
  };
  function coverMarkup(b) {
    if (b.cover) {
      return `<div class="cover" style="background-image:url('${b.cover}')"><span class="spine"></span>` + (b.lastReadAt ? `<span class="pct">${pct(b)}%</span>` : "") + `<button class="del" data-del="${b.id}" title="Remove">${ICON.trash}</button></div>`;
    }
    const initials = (b.author || "").split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
    return `<div class="cover"><span class="spine"></span>
      <div class="gen-cover">
        <div class="gt">${escapeHtml(b.title)}</div>
        <div class="grule"></div>
        <div class="ga">${escapeHtml(b.author || initials || "Unknown")}</div>
      </div>` + (b.lastReadAt ? `<span class="pct">${pct(b)}%</span>` : "") + `<button class="del" data-del="${b.id}" title="Remove">${ICON.trash}</button></div>`;
  }
  function bookCard(b) {
    return `<div class="book" data-open="${b.id}">
    ${coverMarkup(b)}
    <div class="lbl"><div class="t">${escapeHtml(b.title)}</div><div class="a">${escapeHtml(b.author || "\xA0")}</div></div>
  </div>`;
  }
  function renderShelf(list) {
    const perRow = 6;
    let html = "";
    for (let i = 0; i < list.length; i += perRow) {
      const row = list.slice(i, i + perRow);
      html += `<div class="shelf-section"><div class="shelf">${row.map(bookCard).join("")}</div><div class="shelf-plank"></div></div>`;
    }
    return html;
  }
  function renderGrid(list) {
    return `<div class="grid">${list.map(bookCard).join("")}</div>`;
  }
  function renderList(list) {
    const rows = list.map((b) => {
      const cv = b.cover ? `<div class="rcv" style="background-image:url('${b.cover}')"></div>` : `<div class="rcv"><div class="gen-cover"><div class="gt">${escapeHtml(b.title)}</div></div></div>`;
      return `<div class="row" data-open="${b.id}">
      ${cv}
      <div class="rmeta"><div class="rt">${escapeHtml(b.title)}</div><div class="ra">${escapeHtml(b.author || "Unknown author")}</div></div>
      <div class="rprog"><div class="progress"><i style="width:${pct(b)}%"></i></div><span class="progress-num">${b.lastReadAt ? pct(b) + "%" : "New"}</span></div>
      <div class="rwhen">${relTime(b.lastReadAt)}</div>
      <button class="rresume" data-open="${b.id}">${ICON.play}${b.lastReadAt ? "Resume" : "Read"}</button>
      <button class="del rmenu" data-del="${b.id}" title="Remove">${ICON.trash}</button>
    </div>`;
    }).join("");
    return `<div class="list">${rows}</div>`;
  }
  function renderContinue() {
    const c = el("continue");
    const read = books.filter((b2) => b2.lastReadAt > 0).sort((a, b2) => b2.lastReadAt - a.lastReadAt);
    if (!read.length) {
      c.classList.remove("show");
      return;
    }
    const b = read[0];
    c.classList.add("show");
    c.setAttribute("data-open", b.id);
    const cv = el("cont-cover");
    cv.style.backgroundImage = b.cover ? `url('${b.cover}')` : "none";
    cv.innerHTML = b.cover ? "" : `<div class="gen-cover" style="position:absolute;inset:0;border-radius:2px"><div class="gt" style="font-size:13px">${escapeHtml(b.title)}</div><div class="grule"></div><div class="ga">${escapeHtml(b.author)}</div></div>`;
    el("cont-title").textContent = b.title;
    el("cont-author").textContent = b.author || "Unknown author";
    el("cont-bar").style.width = pct(b) + "%";
    el("cont-num").textContent = "Page " + b.currentPage + " of " + b.numPages + " \xB7 " + pct(b) + "%";
  }
  function renderLibrary() {
    document.querySelectorAll("#viewswitch button").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.view === viewMode);
    });
    el("lib-count").textContent = books.length ? books.length + (books.length === 1 ? " volume" : " volumes") : "";
    renderContinue();
    const body = el("lib-body");
    if (!books.length) {
      el("continue").classList.remove("show");
      body.innerHTML = `<div class="empty">
      <div class="ic">\u2766</div>
      <h3>Your shelves are empty</h3>
      <p>Add a PDF to begin your collection. Everything stays privately on this device.</p>
      <button class="mast-btn brass" id="empty-add" style="margin:0 auto">Add your first book</button>
    </div>`;
      const ea = document.getElementById("empty-add");
      if (ea) ea.addEventListener("click", () => el("file-input").click());
      return;
    }
    const list = books.slice().sort((a, b) => (b.lastReadAt || b.addedAt) - (a.lastReadAt || a.addedAt));
    if (viewMode === "shelf") body.innerHTML = renderShelf(list);
    else if (viewMode === "grid") body.innerHTML = renderGrid(list);
    else body.innerHTML = renderList(list);
  }
  function wireLibrary() {
    el("library").addEventListener("click", (e) => {
      const t = e.target;
      const del = t.closest("[data-del]");
      if (del) {
        e.preventDefault();
        e.stopPropagation();
        confirmDelete(del.dataset.del);
        return;
      }
      const open = t.closest("[data-open]");
      if (open) {
        e.preventDefault();
        openBook(open.dataset.open);
      }
    });
    el("continue").addEventListener("click", (e) => {
      e.preventDefault();
      const id = el("continue").getAttribute("data-open");
      if (id) openBook(id);
    });
  }
  async function confirmDelete(id) {
    const b = books.find((x) => x.id === id);
    if (!b) return;
    if (!window.confirm("Remove \u201C" + b.title + "\u201D from your library?\nThis deletes the file from this device.")) return;
    await dbDel(id);
    books = books.filter((x) => x.id !== id);
    renderLibrary();
    toast("Removed from library");
  }
  function wireViewSwitch() {
    el("viewswitch").addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      viewMode = btn.dataset.view;
      localStorage.setItem(LS.view, viewMode);
      renderLibrary();
    });
  }
  const reader = {
    book: null,
    doc: null,
    page: 1,
    width: localStorage.getItem(LS.width) || "comfort",
    zoom: 1,
    rendering: false,
    renderToken: 0,
    saveTimer: 0,
    peekTimer: 0
  };
  async function openBook(id) {
    const b = await dbGet(id);
    if (!b) {
      toast("Could not open that book");
      return;
    }
    reader.book = b;
    reader.page = Math.min(Math.max(1, b.currentPage || 1), b.numPages);
    reader.zoom = 1;
    el("r-title-t").textContent = b.title;
    el("r-title-a").textContent = b.author || "";
    el("r-total").textContent = "/ " + b.numPages;
    setWidthButtons();
    const rd = el("reader");
    rd.classList.add("show");
    document.body.style.overflow = "hidden";
    el("r-loading").classList.remove("hidden");
    try {
      reader.doc = await loadDoc(b.data);
      await renderPage(reader.page, false);
    } catch (e) {
      console.error(e);
      toast("Failed to load this PDF");
    }
    el("r-loading").classList.add("hidden");
  }
  function closeReader() {
    exitZen();
    el("reader").classList.remove("show");
    document.body.style.overflow = "";
    reader.doc = null;
    reader.book = null;
    renderLibrary();
  }
  function stageWidth() {
    const stage = el("r-stage");
    return stage.clientWidth;
  }
  async function renderPage(n, keepScroll) {
    if (!reader.doc || !reader.book) return;
    n = Math.min(Math.max(1, n), reader.book.numPages);
    reader.page = n;
    const token = ++reader.renderToken;
    const page = await reader.doc.getPage(n);
    if (token !== reader.renderToken) return;
    const v1 = page.getViewport({ scale: 1 });
    const avail = stageWidth();
    const sidePad = avail < 700 ? 36 : 64;
    const cap = reader.width === "comfort" ? 860 : Infinity;
    const targetCSS = Math.floor(Math.min(avail - sidePad, cap) * reader.zoom);
    const cssScale = targetCSS / v1.width;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vp = page.getViewport({ scale: cssScale * dpr });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    canvas.style.width = targetCSS + "px";
    canvas.style.height = Math.round(targetCSS * (v1.height / v1.width)) + "px";
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
    if (token !== reader.renderToken) return;
    const col = el("r-col");
    col.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "rpage";
    wrap.appendChild(canvas);
    col.appendChild(wrap);
    if (!keepScroll) el("r-stage").scrollTop = 0;
    updateReaderChrome();
    persistPage();
  }
  function updateReaderChrome() {
    const b = reader.book;
    if (!b) return;
    el("r-page-input").value = String(reader.page);
    const p = b.numPages <= 1 ? 100 : (reader.page - 1) / (b.numPages - 1) * 100;
    el("r-progress-bar").style.width = p + "%";
    el("r-prev").disabled = reader.page <= 1;
    el("r-next").disabled = reader.page >= b.numPages;
    el("r-prev-s").disabled = reader.page <= 1;
    el("r-next-s").disabled = reader.page >= b.numPages;
  }
  function persistPage() {
    const b = reader.book;
    if (!b) return;
    b.currentPage = reader.page;
    b.lastReadAt = Date.now();
    const cached = books.find((x) => x.id === b.id);
    if (cached) {
      cached.currentPage = b.currentPage;
      cached.lastReadAt = b.lastReadAt;
    }
    window.clearTimeout(reader.saveTimer);
    reader.saveTimer = window.setTimeout(() => {
      dbPut(b).catch(() => {
      });
    }, 350);
  }
  function go(delta) {
    if (!reader.book) return;
    const next = reader.page + delta;
    if (next < 1 || next > reader.book.numPages) return;
    renderPage(next, false);
  }
  function setWidthButtons() {
    document.querySelectorAll("#width-seg button").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.w === reader.width);
    });
  }
  let resizeTimer = 0;
  function onResize() {
    if (!el("reader").classList.contains("show")) return;
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => renderPage(reader.page, true), 160);
  }
  function enterZen() {
    const rd = el("reader");
    rd.classList.add("zen");
    const hint = el("zen-hint");
    hint.classList.add("show");
    window.setTimeout(() => hint.classList.remove("show"), 2600);
    if (rd.requestFullscreen) rd.requestFullscreen().catch(() => {
    });
    window.setTimeout(() => renderPage(reader.page, true), 120);
  }
  function exitZen() {
    const rd = el("reader");
    if (!rd.classList.contains("zen")) return;
    rd.classList.remove("zen", "peek");
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {
    });
    window.setTimeout(() => renderPage(reader.page, true), 120);
  }
  function toggleZen() {
    el("reader").classList.contains("zen") ? exitZen() : enterZen();
  }
  function peek() {
    const rd = el("reader");
    if (!rd.classList.contains("zen")) return;
    rd.classList.add("peek");
    window.clearTimeout(reader.peekTimer);
    reader.peekTimer = window.setTimeout(() => rd.classList.remove("peek"), 2200);
  }
  function wireReader() {
    el("r-back").addEventListener("click", closeReader);
    el("r-prev").addEventListener("click", () => go(-1));
    el("r-next").addEventListener("click", () => go(1));
    el("r-prev-s").addEventListener("click", () => go(-1));
    el("r-next-s").addEventListener("click", () => go(1));
    el("r-focus").addEventListener("click", toggleZen);
    el("r-zoom-in").addEventListener("click", () => {
      reader.zoom = Math.min(reader.zoom + 0.15, 2.2);
      renderPage(reader.page, true);
    });
    el("r-zoom-out").addEventListener("click", () => {
      reader.zoom = Math.max(reader.zoom - 0.15, 0.6);
      renderPage(reader.page, true);
    });
    el("width-seg").addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      reader.width = btn.dataset.w;
      localStorage.setItem(LS.width, reader.width);
      reader.zoom = 1;
      setWidthButtons();
      renderPage(reader.page, true);
    });
    const pi = el("r-page-input");
    const commit = () => {
      const v = parseInt(pi.value, 10);
      if (!isNaN(v) && reader.book) renderPage(v, false);
      else pi.value = String(reader.page);
    };
    pi.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        commit();
        pi.blur();
      }
    });
    pi.addEventListener("blur", commit);
    el("reader").addEventListener("mousemove", peek);
    el("r-stage").addEventListener("click", (e) => {
      if (window.getSelection && String(window.getSelection())) return;
      const x = e.clientX;
      const w = window.innerWidth;
      if (x < w * 0.32) go(-1);
      else if (x > w * 0.68) go(1);
    });
    document.addEventListener("fullscreenchange", () => {
      if (!document.fullscreenElement) el("reader").classList.remove("zen", "peek");
    });
    document.addEventListener("keydown", (e) => {
      if (!el("reader").classList.contains("show")) return;
      const k = e.key;
      const tag = document.activeElement && document.activeElement.tagName || "";
      if (tag === "INPUT") return;
      if (k === "ArrowRight" || k === "PageDown" || k === " ") {
        e.preventDefault();
        go(1);
      } else if (k === "ArrowLeft" || k === "PageUp") {
        e.preventDefault();
        go(-1);
      } else if (k === "ArrowDown") {
        el("r-stage").scrollTop += 120;
      } else if (k === "ArrowUp") {
        el("r-stage").scrollTop -= 120;
      } else if (k === "Home") {
        e.preventDefault();
        renderPage(1, false);
      } else if (k === "End" && reader.book) {
        e.preventDefault();
        renderPage(reader.book.numPages, false);
      } else if (k === "f" || k === "F") {
        toggleZen();
      } else if (k === "Escape") {
        if (el("reader").classList.contains("zen")) exitZen();
        else closeReader();
      }
    });
    window.addEventListener("resize", onResize);
  }
  function showApp(name) {
    el("login").classList.add("hidden");
    el("app").classList.remove("hidden");
    const initial = (name.trim()[0] || "R").toUpperCase();
    el("avatar-initial").textContent = initial;
    el("user-name").textContent = name.trim() || "Reader";
  }
  function wireAuth() {
    el("login-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = el("login-name").value.trim() || "Reader";
      const pass = el("login-pass").value;
      if (!pass) return;
      localStorage.setItem(LS.user, JSON.stringify({ name }));
      showApp(name);
      await boot();
    });
    el("avatar").addEventListener("click", (e) => {
      e.stopPropagation();
      el("dropdown").classList.toggle("hidden");
    });
    document.addEventListener("click", () => el("dropdown").classList.add("hidden"));
    el("dropdown").addEventListener("click", (e) => e.stopPropagation());
    el("btn-logout").addEventListener("click", () => {
      localStorage.removeItem(LS.user);
      el("app").classList.add("hidden");
      el("login").classList.remove("hidden");
      el("dropdown").classList.add("hidden");
      el("login-pass").value = "";
    });
    el("brand").addEventListener("click", () => {
      if (el("reader").classList.contains("show")) closeReader();
    });
  }
  function wireUpload() {
    el("btn-upload").addEventListener("click", () => el("file-input").click());
    el("file-input").addEventListener("change", (e) => {
      const files = e.target.files;
      if (files && files.length) addFiles(files);
      e.target.value = "";
    });
    let dragDepth = 0;
    const drop = el("drop");
    window.addEventListener("dragenter", (e) => {
      if (el("login").classList.contains("hidden") === false) return;
      e.preventDefault();
      dragDepth++;
      drop.classList.add("show");
    });
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("dragleave", (e) => {
      e.preventDefault();
      dragDepth--;
      if (dragDepth <= 0) {
        drop.classList.remove("show");
        dragDepth = 0;
      }
    });
    window.addEventListener("drop", (e) => {
      e.preventDefault();
      dragDepth = 0;
      drop.classList.remove("show");
      if (el("login").classList.contains("hidden") === false) return;
      const dt = e.dataTransfer;
      if (dt && dt.files && dt.files.length) addFiles(dt.files);
    });
  }
  let booted = false;
  async function boot() {
    if (booted) {
      renderLibrary();
      return;
    }
    booted = true;
    try {
      books = await dbAll();
      if (!books.length) await seedIfEmpty();
      books = await dbAll();
    } catch (e) {
      console.error("db error", e);
      books = [];
    }
    renderLibrary();
  }
  function init() {
    wireAuth();
    wireViewSwitch();
    wireLibrary();
    wireUpload();
    wireReader();
    const saved = localStorage.getItem(LS.user);
    if (saved) {
      try {
        const u = JSON.parse(saved);
        showApp(u.name || "Reader");
        boot();
      } catch {
      }
    }
  }
  init();
})();
