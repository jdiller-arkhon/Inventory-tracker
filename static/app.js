"use strict";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const STATUS_LABEL = { in_stock: "In stock", listed: "Listed", sold: "Sold", personal: "Personal" };
const CAT_LABEL = { card: "Card", figure: "Figure", art: "Art" };
const money = (n) =>
  n == null || n === "" ? "—" : Number(n).toLocaleString(undefined, { style: "currency", currency: "USD" });
const moneyShort = (n) =>
  Math.abs(n) >= 1000 ? `${n < 0 ? "-" : ""}$${(Math.abs(n) / 1000).toFixed(1)}k` : `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(0)}`;
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const signed = (n) => (n == null ? "" : n > 0 ? "pos" : n < 0 ? "neg" : "");

const state = {
  sort: "updated_at", order: "desc", items: [],
  editing: null, selling: null,
  pendingPhotos: [], uploading: [], onCreated: null,
};

// Whatnot's published seller fees: 8% commission on the item price, plus payment
// processing of 2.9% + $0.30. Adjust here if your rates differ (e.g. electronics, coins).
const WHATNOT_FEES = { commission: 0.08, processingPct: 0.029, processingFixed: 0.3 };

async function api(path, options = {}) {
  const opts = { ...options, headers: { ...(options.headers || {}) } };
  if (opts.body && typeof opts.body !== "string") {
    opts.body = JSON.stringify(opts.body);
    opts.headers["Content-Type"] = "application/json";
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 2600);
}

/* ------------------------------------------------------------------ Theme */

function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem("theme"); } catch {}
  if (saved) document.documentElement.dataset.theme = saved;
  $("#theme-toggle").addEventListener("click", () => {
    const current = document.documentElement.dataset.theme ||
      (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("theme", next); } catch {}
  });
}

/* ------------------------------------------------------------------ Views */

function showView(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === name));
  $$(".view").forEach((v) => (v.hidden = v.id !== `view-${name}`));
  try { localStorage.setItem("view", name); } catch {}
  if (name === "dashboard") loadStats();
  else if (name === "photos") enterPhotos();
  else loadItems();
}

function refresh() {
  if (!$("#view-dashboard").hidden) loadStats();
  else if (!$("#view-photos").hidden) refreshQueueItem();
  else loadItems();
}

/* -------------------------------------------------------------- Dashboard */

async function loadStats() {
  let s;
  try { s = await api("/api/stats"); } catch (e) { return toast(e.message); }
  const t = s.totals;
  const tiles = [
    ["Items in stock", t.inventory_items.toLocaleString(), `${t.inventory_units.toLocaleString()} units · ${t.listed_items} listed`],
    ["Invested in stock", money(t.inventory_cost), "cost + inbound shipping"],
    ["Est. stock value", money(t.inventory_value), "market value, else list price, else cost"],
    ["Revenue", money(t.revenue), `${t.sold_items} sold`],
    ["Net profit", money(t.profit), t.roi == null ? "after cost, fees & shipping" : `${t.roi}% ROI`, signed(t.profit)],
    ["Avg. days to sell", t.avg_days_to_sell ?? "—", `${s.aging_count} aging (90+ days)`],
    ["Need photos", s.missing_photos, s.missing_photos ? "open the Photos tab to shoot them" : "all stock has photos", "", "photos"],
  ];
  $("#kpis").innerHTML = tiles
    .map(([label, value, sub, cls, view]) =>
      `<div class="kpi ${view ? "link" : ""}" ${view ? `data-goto="${view}" role="button" tabindex="0"` : ""}>` +
      `<div class="label">${label}</div><div class="value ${cls || ""}">${value}</div><div class="sub">${esc(sub)}</div></div>`)
    .join("");

  renderMonthlyChart(s.monthly);
  $("#monthly-table").innerHTML = table(
    ["Month", "Sold", "Revenue", "Profit"],
    s.monthly.map((m) => [monthLabel(m.month, true), m.sold, money(m.revenue), money(m.profit)]),
    [false, true, true, true]
  );

  $("#category-table").innerHTML = table(
    ["Category", "In stock", "Invested", "Est. value", "Sold", "Revenue", "Profit"],
    Object.entries(s.by_category).map(([cat, c]) => [
      CAT_LABEL[cat] + "s", c.inventory_items, money(c.inventory_cost), money(c.inventory_value),
      c.sold_items, money(c.revenue), `<span class="${signed(c.profit)}">${money(c.profit)}</span>`,
    ]),
    [false, true, true, true, true, true, true]
  );

  $("#platform-table").innerHTML = s.platforms.length
    ? table(["Platform", "Sold", "Revenue", "Profit"],
        s.platforms.map((p) => [esc(p.platform), p.sold, money(p.revenue), `<span class="${signed(p.profit)}">${money(p.profit)}</span>`]),
        [false, true, true, true])
    : `<p class="muted small">No sales recorded yet.</p>`;

  $("#aging-table").innerHTML = s.aging.length
    ? table(["SKU", "Item", "Status", "Days held", "Cost"],
        s.aging.map((i) => [esc(i.sku), `<span class="cat">${CAT_LABEL[i.category]}</span>${esc(i.name)}`,
          `<span class="badge ${i.status}">${STATUS_LABEL[i.status]}</span>`, i.days_held, money(i.total_cost)]),
        [false, false, false, true, true])
    : `<p class="muted small">Nothing has been sitting for 90+ days. Nice.</p>`;
}

function table(headers, rows, numeric) {
  const th = headers.map((h, i) => `<th class="${numeric[i] ? "num" : ""}">${h}</th>`).join("");
  const body = rows
    .map((r) => `<tr>${r.map((c, i) => `<td class="${numeric[i] ? "num" : ""}">${c}</td>`).join("")}</tr>`)
    .join("");
  return `<div style="overflow-x:auto"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function monthLabel(key, withYear) {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleString(undefined, withYear ? { month: "short", year: "numeric" } : { month: "short" });
}

function niceStep(range) {
  const raw = range / 4;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  return [1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => s >= raw) || mag * 10;
}

function renderMonthlyChart(monthly) {
  const host = $("#monthly-chart");
  const W = Math.max(host.clientWidth || 600, 320), H = 240;
  const pad = { l: 52, r: 8, t: 18, b: 24 };
  const vals = monthly.map((m) => m.profit);
  let max = Math.max(0, ...vals), min = Math.min(0, ...vals);
  if (max === min) max = 100;
  const step = niceStep(max - min);
  max = Math.ceil(max / step) * step;
  min = Math.floor(min / step) * step;
  const y = (v) => pad.t + ((max - v) / (max - min)) * (H - pad.t - pad.b);
  const band = (W - pad.l - pad.r) / monthly.length;
  const bw = Math.min(24, band * 0.6);
  const r = 4;

  let grid = "";
  for (let v = min; v <= max + 1e-9; v += step) {
    grid += `<line class="${v === 0 ? "baseline" : "gridline"}" x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}"/>`;
    grid += `<text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${moneyShort(v)}</text>`;
  }

  const bestIdx = vals.indexOf(Math.max(...vals));
  let bars = "";
  monthly.forEach((m, i) => {
    const cx = pad.l + band * i + band / 2;
    const x = cx - bw / 2;
    const y0 = y(0), y1 = y(m.profit);
    const h = Math.abs(y1 - y0);
    if (h > 0.5) {
      // Rounded data-end (top for gains, bottom for losses), square at the baseline.
      const rr = Math.min(r, h, bw / 2);
      const d = m.profit >= 0
        ? `M${x},${y0} V${y1 + rr} Q${x},${y1} ${x + rr},${y1} H${x + bw - rr} Q${x + bw},${y1} ${x + bw},${y1 + rr} V${y0} Z`
        : `M${x},${y0} V${y1 - rr} Q${x},${y1} ${x + rr},${y1} H${x + bw - rr} Q${x + bw},${y1} ${x + bw},${y1 - rr} V${y0} Z`;
      bars += `<path class="bar" data-i="${i}" d="${d}"/>`;
    }
    if (i === bestIdx && m.profit > 0) {
      bars += `<text class="val" x="${cx}" y="${y1 - 5}" text-anchor="middle">${moneyShort(m.profit)}</text>`;
    }
    bars += `<text x="${cx}" y="${H - 6}" text-anchor="middle">${monthLabel(m.month)}</text>`;
    bars += `<rect class="hit" data-i="${i}" x="${pad.l + band * i}" y="${pad.t}" width="${band}" height="${H - pad.t - pad.b}"/>`;
  });

  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Net profit by month for the last 12 months">
    <g class="axis">${grid}${bars}</g></svg><div class="tooltip" hidden></div>`;

  const tip = $(".tooltip", host);
  $$(".hit", host).forEach((hit) => {
    hit.addEventListener("mousemove", (ev) => {
      const m = monthly[hit.dataset.i];
      $$(".bar", host).forEach((b) => b.classList.toggle("hover", b.dataset.i === hit.dataset.i));
      tip.innerHTML = `<b>${monthLabel(m.month, true)}</b>Profit: ${money(m.profit)}<br>Revenue: ${money(m.revenue)}<br>${m.sold} sold`;
      tip.hidden = false;
      const box = host.getBoundingClientRect();
      const left = Math.min(ev.clientX - box.left + 12, box.width - tip.offsetWidth - 4);
      tip.style.left = `${Math.max(0, left)}px`;
      tip.style.top = `${ev.clientY - box.top - tip.offsetHeight - 10}px`;
    });
    hit.addEventListener("mouseleave", () => {
      tip.hidden = true;
      $$(".bar", host).forEach((b) => b.classList.remove("hover"));
    });
  });
}

/* -------------------------------------------------------------- Inventory */

async function loadItems() {
  const params = new URLSearchParams({
    q: $("#search").value.trim(),
    category: $("#filter-category").value,
    status: $("#filter-status").value,
    photos: $("#filter-photos").value,
    sort: state.sort,
    order: state.order,
  });
  try { state.items = await api(`/api/items?${params}`); } catch (e) { return toast(e.message); }
  renderItems();
}

function detailLine(i) {
  const parts = {
    card: [i.set_name, i.card_number && `#${i.card_number}`, i.grader && i.grader !== "Raw" ? `${i.grader} ${i.grade || ""}`.trim() : i.grader],
    figure: [i.brand, i.series, i.packaging],
    art: [i.artist, i.medium, i.dimensions, i.edition, i.signed === "Yes" && "signed"],
  }[i.category] || [];
  return [i.year, ...parts, i.condition].filter(Boolean).join(" · ");
}

function renderItems() {
  const tbody = $("#items-table tbody");
  $("#empty").hidden = state.items.length > 0;
  tbody.innerHTML = state.items.map((i) => {
    const thumb = `<div class="thumb-wrap">${i.photo_url
      ? `<img class="thumb" src="${esc(i.photo_url)}" alt="" loading="lazy">`
      : `<div class="thumb none" title="No photos yet">${CAT_LABEL[i.category][0]}</div>`}` +
      `${i.photo_count > 1 ? `<span class="thumb-count">${i.photo_count}</span>` : ""}</div>`;
    const value = i.list_price != null
      ? `${money(i.list_price)}<div class="sub">${i.market_value != null ? `mkt ${money(i.market_value)}` : "list"}</div>`
      : money(i.market_value);
    const sold = i.status === "sold"
      ? `${money(i.sale_price)}<div class="sub ${signed(i.profit)}">${i.profit >= 0 ? "+" : ""}${money(i.profit)}</div>`
      : "";
    const actions = `<button class="btn small" data-kit="${i.id}" title="Photos, title and description for your listing">Listing</button>` +
      (i.status === "sold" ? "" : ` <button class="btn small" data-sell="${i.id}">Sell</button>`);
    return `<tr data-id="${i.id}">
      <td>${thumb}</td>
      <td class="small">${esc(i.sku)}</td>
      <td><div class="title"><span class="cat">${CAT_LABEL[i.category]}</span>${esc(i.name)}</div><div class="sub">${esc(detailLine(i))}</div></td>
      <td><span class="badge ${i.status}">${STATUS_LABEL[i.status]}</span>${i.listed_platform && i.status === "listed" ? `<div class="sub">${esc(i.listed_platform)}</div>` : ""}</td>
      <td class="num">${i.quantity}</td>
      <td class="num">${money(i.total_cost)}</td>
      <td class="num">${value}</td>
      <td class="num">${sold}</td>
      <td class="num">${i.days_held ?? ""}</td>
      <td class="small">${esc(i.location)}</td>
      <td class="actions">${actions}</td>
    </tr>`;
  }).join("");

  const unitCount = state.items.reduce((a, i) => a + (i.quantity || 1), 0);
  const cost = state.items.reduce((a, i) => a + i.total_cost, 0);
  $("#summary").textContent = `${state.items.length} rows · ${unitCount} units · ${money(cost)} total cost`;

  $$("#items-table th[data-sort]").forEach((th) => {
    th.classList.toggle("sorted", th.dataset.sort === state.sort);
    th.classList.toggle("asc", th.dataset.sort === state.sort && state.order === "asc");
  });
}

/* ------------------------------------------------------------- Item form */

const form = $("#item-form");
const dialog = $("#item-dialog");

function setCategory(cat) {
  $$("fieldset[data-cat]", form).forEach((fs) => (fs.hidden = fs.dataset.cat !== cat));
}

function toggleSaleSection() {
  $("fieldset[data-sale]", form).hidden = form.elements.status.value !== "sold";
}

function openItemForm(item = null, photos = [], onCreated = null) {
  form.reset();
  state.editing = item;
  state.pendingPhotos = photos.map((p) => ({ key: `p${++photoSeq}`, url: p.url }));
  state.uploading = [];
  state.onCreated = onCreated;
  $("#form-error").hidden = true;
  $("#item-dialog-title").textContent = item ? `Edit ${item.sku || "item"}` : "Add item";
  $("#delete-btn").hidden = !item;
  $("#form-kit-btn").hidden = !item;
  if (item) {
    for (const el of form.elements) {
      if (!el.name || el.type === "file") continue;
      if (el.type === "radio") el.checked = el.value === item[el.name];
      else el.value = item[el.name] ?? "";
    }
  } else {
    const cat = $("#filter-category").value;
    if (cat) form.elements.category.value = cat;
    form.elements.purchase_date.value = today();
  }
  setCategory(form.elements.category.value);
  toggleSaleSection();
  renderFormGallery();
  dialog.showModal();
  form.elements.name.focus();
}

function today() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function formData(f) {
  const data = {};
  for (const el of f.elements) {
    if (!el.name || el.type === "file") continue;
    if (el.type === "radio") { if (el.checked) data[el.name] = el.value; continue; }
    data[el.name] = el.value;
  }
  return data;
}

form.addEventListener("change", (e) => {
  if (e.target.name === "category") setCategory(e.target.value);
  if (e.target.name === "status") toggleSaleSection();
});

function formPhotos() {
  return [...(state.editing ? savedPhotos(state.editing) : state.pendingPhotos), ...state.uploading];
}

function renderFormGallery() {
  const item = state.editing;
  renderGallery($("#form-gallery"), formPhotos(), {
    onCover: async (key) => {
      if (!item) {
        const idx = state.pendingPhotos.findIndex((p) => p.key === key);
        state.pendingPhotos.unshift(...state.pendingPhotos.splice(idx, 1));
        return renderFormGallery();
      }
      try { state.editing = await api(`/api/items/${item.id}/photos/${key}/cover`, { method: "POST" }); } catch (e) { toast(e.message); }
      renderFormGallery();
      refresh();
    },
    onDelete: async (key) => {
      if (!item) {
        state.pendingPhotos = state.pendingPhotos.filter((p) => p.key !== key);
        return renderFormGallery();
      }
      if (!confirm("Delete this photo?")) return;
      try { state.editing = await api(`/api/items/${item.id}/photos/${key}`, { method: "DELETE" }); } catch (e) { toast(e.message); }
      renderFormGallery();
      refresh();
    },
  });
  const zip = $("#form-zip");
  zip.hidden = !item?.photo_count;
  if (item) zip.href = `/api/items/${item.id}/photos.zip`;
}

async function formAddFiles(input) {
  const files = [...input.files];
  input.value = "";
  if (!state.editing) {
    for (const img of await readImages(files)) state.pendingPhotos.push({ key: `p${++photoSeq}`, url: img.url });
    return renderFormGallery();
  }
  const itemId = state.editing.id;
  await uploadEach(files, itemId, {
    onStart: (temp) => { state.uploading.push(temp); renderFormGallery(); },
    onDone: (temp, updated) => {
      state.uploading = state.uploading.filter((u) => u !== temp);
      if (updated && state.editing?.id === itemId) state.editing = updated;
      renderFormGallery();
    },
  });
  refresh();
}

$("#form-camera").addEventListener("change", (e) => formAddFiles(e.target));
$("#form-files").addEventListener("change", (e) => formAddFiles(e.target));
$("#form-kit-btn").addEventListener("click", () => openKit(state.editing));

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = formData(form);
  try {
    let item = state.editing
      ? await api(`/api/items/${state.editing.id}`, { method: "PUT", body: data })
      : await api("/api/items", { method: "POST", body: data });
    if (!state.editing) {
      for (const p of state.pendingPhotos) {
        item = await api(`/api/items/${item.id}/photos`, { method: "POST", body: { images: [p.url] } });
      }
      state.onCreated?.(item);
    }
    dialog.close();
    toast(state.editing ? "Saved" : `Added ${item.sku}`);
    refresh();
  } catch (err) {
    $("#form-error").textContent = err.message;
    $("#form-error").hidden = false;
  }
});

$("#delete-btn").addEventListener("click", async () => {
  const item = state.editing;
  if (!item || !confirm(`Delete "${item.name}"? This can't be undone.`)) return;
  try {
    await api(`/api/items/${item.id}`, { method: "DELETE" });
    dialog.close();
    toast("Deleted");
    refresh();
  } catch (err) { toast(err.message); }
});

/* ------------------------------------------------------------- Sell form */

const sellForm = $("#sell-form");
const sellDialog = $("#sell-dialog");

function openSell(item) {
  state.selling = item;
  sellForm.reset();
  $("#sell-error").hidden = true;
  $("#sell-item").innerHTML = `<b>${esc(item.name)}</b> · ${esc(item.sku)} · cost ${money(item.total_cost)} for ${item.quantity}`;
  const f = sellForm.elements;
  f.quantity.value = item.quantity;
  f.quantity.max = item.quantity;
  f.quantity.closest("label").hidden = item.quantity <= 1;
  f.sale_price.value = item.list_price ?? "";
  f.sale_date.value = today();
  f.sale_platform.value = item.listed_platform || "Whatnot";
  f.fees.dataset.auto = "1";
  updateSellPreview();
  sellDialog.showModal();
  f.sale_price.focus();
}

function num(v) {
  const n = parseFloat(String(v).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function updateSellPreview() {
  const item = state.selling;
  if (!item) return;
  const f = sellForm.elements;
  const isWhatnot = /whatnot/i.test(f.sale_platform.value);
  const estimate = whatnotFees(num(f.sale_price.value));
  if (isWhatnot && f.fees.dataset.auto === "1") f.fees.value = estimate ? estimate.toFixed(2) : "";
  $("#fee-note").hidden = !isWhatnot;
  $("#fee-note").innerHTML = f.fees.dataset.auto === "1"
    ? "Fees estimated for Whatnot: 8% commission + 2.9% + $0.30 processing. Processing also applies to the " +
      "shipping and tax the buyer pays, so check your payout for the exact figure."
    : `Whatnot estimate would be ${money(estimate)}. <button type="button" class="btn small" id="fee-reset">Use estimate</button>`;
  const qty = Math.min(Math.max(parseInt(f.quantity.value, 10) || item.quantity, 1), item.quantity);
  const cost = item.total_cost * (qty / item.quantity);
  const profit = num(f.sale_price.value) - cost - num(f.fees.value) - num(f.shipping_out.value);
  $("#sell-preview").innerHTML = `Estimated profit: <b class="${signed(profit)}">${money(profit)}</b>` +
    (qty < item.quantity ? ` · ${item.quantity - qty} will stay in stock` : "");
}

function whatnotFees(price) {
  if (!(price > 0)) return 0;
  const { commission, processingPct, processingFixed } = WHATNOT_FEES;
  return Math.round((price * (commission + processingPct) + processingFixed) * 100) / 100;
}

sellForm.addEventListener("input", (e) => {
  if (e.target.name === "fees") e.target.dataset.auto = "";
  updateSellPreview();
});
sellForm.addEventListener("click", (e) => {
  if (e.target.id !== "fee-reset") return;
  sellForm.elements.fees.dataset.auto = "1";
  updateSellPreview();
});
sellForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api(`/api/items/${state.selling.id}/sell`, { method: "POST", body: formData(sellForm) });
    sellDialog.close();
    toast("Sale recorded");
    refresh();
  } catch (err) {
    $("#sell-error").textContent = err.message;
    $("#sell-error").hidden = false;
  }
});

/* ------------------------------------------------------------ Import etc */

$("#export-btn").addEventListener("click", () => (location.href = "/api/export.csv"));

$("#import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const res = await api("/api/import", { method: "POST", body: await file.text(), headers: { "Content-Type": "text/csv" } });
    let msg = `Imported: ${res.created} added, ${res.updated} updated`;
    if (res.errors.length) {
      msg += `, ${res.errors.length} skipped`;
      alert(`Some rows were skipped:\n\n${res.errors.slice(0, 20).join("\n")}${res.errors.length > 20 ? "\n…" : ""}`);
    }
    toast(msg);
    loadItems();
  } catch (err) { toast(err.message); }
});

/* ---------------------------------------------------------------- Photos */

let photoSeq = 0;

// Shrinks a photo before upload so phone shots (often 4000px+) stay small on disk.
async function resizeImage(file, maxSize = 1600) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas.toDataURL("image/jpeg", 0.88);
}

async function readImages(files) {
  const out = [];
  for (const file of files) {
    try { out.push({ name: file.name, url: await resizeImage(file) }); }
    catch { toast(`Couldn't read ${file.name}. Try a JPEG or PNG.`); }
  }
  return out;
}

const savedPhotos = (item) => (item?.photos || []).map((p) => ({ key: String(p.id), url: p.url }));

// Uploads files one at a time (keeps each request small) and reports progress.
async function uploadEach(files, itemId, { onStart, onDone }) {
  let updated = null;
  for (const file of files) {
    let url;
    try { url = await resizeImage(file); } catch { toast(`Couldn't read ${file.name}`); continue; }
    const temp = { key: `u${++photoSeq}`, url, busy: true };
    onStart(temp);
    try {
      updated = await api(`/api/items/${itemId}/photos`, { method: "POST", body: { images: [url] } });
      onDone(temp, updated);
    } catch (e) {
      toast(e.message);
      onDone(temp, null);
    }
  }
  return updated;
}

function renderGallery(host, photos, { onCover, onDelete } = {}) {
  host.innerHTML = photos.map((p, i) => {
    const img = `<img src="${esc(p.url)}" alt="Photo ${i + 1}" loading="lazy">`;
    const linked = p.url.startsWith("data:") ? img : `<a href="${esc(p.url)}" target="_blank" rel="noopener">${img}</a>`;
    const tools = p.busy ? "" : `<div class="tools">
        ${i > 0 && onCover ? `<button type="button" data-cover title="Make this the cover photo">&#9733;</button>` : ""}
        ${onDelete ? `<button type="button" data-del title="Delete photo">&#10005;</button>` : ""}
      </div>`;
    return `<div class="ph ${i === 0 ? "cover" : ""} ${p.busy ? "busy" : ""}" data-key="${esc(p.key)}">
      ${linked}${i === 0 && !p.busy ? '<span class="tag">Cover</span>' : ""}${tools}</div>`;
  }).join("");
  host.onclick = (e) => {
    const key = e.target.closest(".ph")?.dataset.key;
    if (!key) return;
    if (e.target.closest("[data-cover]")) onCover(key);
    else if (e.target.closest("[data-del]")) onDelete(key);
  };
}

/* ----------------------------------------------------------- Photo queue */

const queue = { items: [], index: 0, uploading: [] };

async function enterPhotos() {
  loadPhoneInfo();
  loadItemOptions();
  await loadQueue();
}

async function loadQueue(resetIndex = false) {
  const mode = $("#queue-filter").value;
  const params = new URLSearchParams();
  if (mode !== "all") params.set("status", "unsold");
  if (mode === "missing") params.set("photos", "missing");
  let items;
  try { items = await api(`/api/items?${params}`); } catch (e) { return toast(e.message); }
  if (mode === "missing") items = items.filter((i) => i.status !== "personal");
  // Walk the shelves in order: group by storage location, then SKU.
  items.sort((a, b) =>
    (a.location || "~").localeCompare(b.location || "~", undefined, { numeric: true }) ||
    (a.sku || "").localeCompare(b.sku || "", undefined, { numeric: true }));
  const currentId = queue.items[queue.index]?.id;
  queue.items = items;
  const keep = resetIndex ? -1 : items.findIndex((i) => i.id === currentId);
  queue.index = keep >= 0 ? keep : 0;
  renderQueue();
}

async function refreshQueueItem() {
  const item = queue.items[queue.index];
  if (!item) return loadQueue();
  try { queue.items[queue.index] = await api(`/api/items/${item.id}`); } catch { return loadQueue(); }
  renderQueue();
  loadItemOptions();
}

function renderQueue() {
  const item = queue.items[queue.index];
  $("#queue-empty").hidden = !!item;
  $("#queue-card").hidden = !item;
  $("#queue-progress").textContent = item ? `Item ${queue.index + 1} of ${queue.items.length}` : "";
  if (!item) return;
  $("#q-sku").textContent = `${CAT_LABEL[item.category].toUpperCase()} · ${item.sku || ""}`;
  $("#q-name").textContent = item.name;
  $("#q-detail").textContent = detailLine(item);
  $("#q-loc").textContent = item.location || "";
  $("#q-prev").disabled = queue.index === 0;
  $("#q-next").innerHTML = queue.index >= queue.items.length - 1 ? "Finish" : "Next item &rarr;";
  renderGallery($("#q-gallery"), [...savedPhotos(item), ...queue.uploading], {
    onCover: async (key) => {
      try { queue.items[queue.index] = await api(`/api/items/${item.id}/photos/${key}/cover`, { method: "POST" }); } catch (e) { toast(e.message); }
      renderQueue();
    },
    onDelete: async (key) => {
      if (!confirm("Delete this photo?")) return;
      try { queue.items[queue.index] = await api(`/api/items/${item.id}/photos/${key}`, { method: "DELETE" }); } catch (e) { toast(e.message); }
      renderQueue();
    },
  });
}

async function queueAddFiles(input) {
  const files = [...input.files];
  input.value = "";
  const item = queue.items[queue.index];
  if (!item || !files.length) return;
  const index = queue.index;
  await uploadEach(files, item.id, {
    onStart: (temp) => { queue.uploading.push(temp); renderQueue(); },
    onDone: (temp, updated) => {
      queue.uploading = queue.uploading.filter((u) => u !== temp);
      if (updated && queue.items[index]?.id === updated.id) queue.items[index] = updated;
      renderQueue();
    },
  });
}

$("#q-camera").addEventListener("change", (e) => queueAddFiles(e.target));
$("#q-files").addEventListener("change", (e) => queueAddFiles(e.target));
$("#q-prev").addEventListener("click", () => { queue.index = Math.max(0, queue.index - 1); renderQueue(); window.scrollTo(0, 0); });
$("#q-next").addEventListener("click", () => {
  if (queue.index < queue.items.length - 1) {
    queue.index += 1;
    renderQueue();
  } else {
    toast("End of the queue");
    loadQueue(true);
  }
  window.scrollTo(0, 0);
});
$("#q-edit").addEventListener("click", () => queue.items[queue.index] && openItemForm(queue.items[queue.index]));
$("#q-kit").addEventListener("click", () => queue.items[queue.index] && openKit(queue.items[queue.index]));
$("#queue-filter").addEventListener("change", () => loadQueue(true));

/* ------------------------------------------------------ Phone connection */

async function loadPhoneInfo() {
  const panel = $("#phone-panel");
  const onThisComputer = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(location.hostname);
  if (!onThisComputer) { panel.hidden = true; return; } // already on the phone
  let info;
  try { info = await api("/api/info"); } catch { return; }
  panel.hidden = false;
  panel.innerHTML = info.phone_urls.length
    ? `<div><b>Shoot from your phone.</b> On a phone connected to the same Wi-Fi, open:</div>
       <div class="url">${info.phone_urls.map(esc).join(" &nbsp;or&nbsp; ")}</div>
       <div class="muted small">Then open the Photos tab there. Tip: use your browser's “Add to Home Screen” so it opens like an app.</div>`
    : `<div><b>Want to shoot straight from your phone?</b> Stop the tracker and start it with
       <code>start-phone.bat</code> (Windows) or <code>./start.sh --phone</code> (Mac/Linux).
       The address to open on your phone will be shown here.</div>`;
}

/* ------------------------------------------------- Bulk upload and match */

const bulk = { unmatched: [] };
let itemOptions = [];

async function loadItemOptions() {
  try { itemOptions = await api("/api/items?sort=sku&order=asc"); } catch { return; }
  $("#item-options").innerHTML = itemOptions
    .map((i) => `<option value="${esc(`${i.sku} — ${i.name}`)}"></option>`).join("");
}

function findOption(text) {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  return itemOptions.find((i) => `${i.sku} — ${i.name}`.toLowerCase() === t) ||
    itemOptions.find((i) => (i.sku || "").toLowerCase() === t.split(" — ")[0]) ||
    itemOptions.find((i) => i.name.toLowerCase() === t);
}

async function handleBulk(fileList) {
  const files = [...fileList]
    .filter((f) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!files.length) return toast("No image files found");
  const status = $("#bulk-status");
  let matches = {};
  try { matches = await api("/api/photos/match", { method: "POST", body: { names: files.map((f) => f.name) } }); }
  catch (e) { return toast(e.message); }

  let attached = 0, unreadable = 0;
  const items = new Set();
  for (const [n, file] of files.entries()) {
    status.textContent = `Processing ${n + 1} of ${files.length}…`;
    let url;
    try { url = await resizeImage(file); } catch { unreadable += 1; continue; }
    const match = matches[file.name];
    if (match) {
      try {
        await api(`/api/items/${match.id}/photos`, { method: "POST", body: { images: [url] } });
        attached += 1;
        items.add(match.id);
      } catch (e) { toast(e.message); }
    } else {
      bulk.unmatched.push({ key: ++photoSeq, name: file.name, url, selected: false });
      renderUnmatched();
    }
  }
  const parts = [`${attached} photo${attached === 1 ? "" : "s"} attached to ${items.size} item${items.size === 1 ? "" : "s"} by SKU`];
  const left = files.length - attached - unreadable;
  if (left) parts.push(`${left} need an item picked below`);
  if (unreadable) parts.push(`${unreadable} couldn't be read (try JPEG/PNG)`);
  status.textContent = parts.join(" · ");
  if (attached) { refreshQueueItem(); loadItemOptions(); }
}

function renderUnmatched() {
  $("#unmatched-wrap").hidden = bulk.unmatched.length === 0;
  const selected = bulk.unmatched.filter((u) => u.selected).length;
  $("#unmatched-count").textContent = `${bulk.unmatched.length} unmatched · ${selected} selected · tap photos to select`;
  $("#unmatched").innerHTML = bulk.unmatched.map((u) =>
    `<div class="um ${u.selected ? "sel" : ""}" data-key="${u.key}" role="checkbox" aria-checked="${u.selected}" tabindex="0">
       <img src="${esc(u.url)}" alt=""><div class="fn">${u.selected ? "&#10003; " : ""}${esc(u.name)}</div></div>`).join("");
}

function selectedUnmatched() {
  const sel = bulk.unmatched.filter((u) => u.selected);
  if (!sel.length) toast("Tap one or more photos to select them first");
  return sel;
}

$("#unmatched").addEventListener("click", (e) => {
  const key = Number(e.target.closest(".um")?.dataset.key);
  const u = bulk.unmatched.find((x) => x.key === key);
  if (!u) return;
  u.selected = !u.selected;
  renderUnmatched();
});
$("#select-all-btn").addEventListener("click", () => {
  const all = bulk.unmatched.every((u) => u.selected);
  bulk.unmatched.forEach((u) => (u.selected = !all));
  renderUnmatched();
});
$("#assign-btn").addEventListener("click", async () => {
  const sel = selectedUnmatched();
  if (!sel.length) return;
  const item = findOption($("#assign-item").value);
  if (!item) return toast("Pick an item from the list (type its SKU or name)");
  for (const u of sel) {
    try {
      await api(`/api/items/${item.id}/photos`, { method: "POST", body: { images: [u.url] } });
      bulk.unmatched = bulk.unmatched.filter((x) => x !== u);
    } catch (e) { toast(e.message); break; }
  }
  renderUnmatched();
  toast(`Attached to ${item.sku}`);
  $("#assign-item").value = "";
  refreshQueueItem();
});
$("#new-from-btn").addEventListener("click", () => {
  const sel = selectedUnmatched();
  if (!sel.length) return;
  openItemForm(null, sel, () => {
    bulk.unmatched = bulk.unmatched.filter((u) => !sel.includes(u));
    renderUnmatched();
    loadItemOptions();
  });
});
$("#discard-btn").addEventListener("click", () => {
  const sel = selectedUnmatched();
  if (!sel.length) return;
  bulk.unmatched = bulk.unmatched.filter((u) => !sel.includes(u));
  renderUnmatched();
});
$("#bulk-files").addEventListener("change", (e) => { const f = [...e.target.files]; e.target.value = ""; handleBulk(f); });
const dropzone = $("#dropzone");
["dragenter", "dragover"].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => dropzone.addEventListener(ev, () => dropzone.classList.remove("over")));
dropzone.addEventListener("drop", (e) => { e.preventDefault(); handleBulk(e.dataTransfer.files); });

/* ------------------------------------------------ Listing kit (Whatnot) */

const kitDialog = $("#kit-dialog");
let kitFiles = Promise.resolve([]);

function listingTitle(i) {
  const graded = i.grader && !/^raw$/i.test(i.grader);
  const parts = {
    card: [i.year, i.set_name, i.name, i.card_number && `#${i.card_number}`, graded && `${i.grader} ${i.grade || ""}`.trim()],
    figure: [i.year, i.brand, i.series, i.name, /sealed/i.test(i.packaging || "") ? "Sealed" : i.packaging === "Loose" ? "Loose" : null],
    art: [i.artist, i.name, i.medium, i.dimensions, i.signed === "Yes" && "Signed", i.edition && `Edition ${i.edition}`],
  }[i.category] || [i.name];
  const name = i.name.toLowerCase();
  // Skip details the item name already mentions (e.g. a name that includes the set).
  return parts.filter(Boolean).filter((p) => p === i.name || !name.includes(String(p).toLowerCase())).join(" ");
}

function listingDescription(i) {
  const graded = i.grader && !/^raw$/i.test(i.grader);
  const rows = {
    card: [["Set", i.set_name], ["Card #", i.card_number], ["Year", i.year],
      ["Grade", graded ? `${i.grader} ${i.grade || ""}`.trim() : null], ["Cert #", graded ? i.cert_number : null]],
    figure: [["Brand", i.brand], ["Line", i.series], ["Year", i.year], ["Packaging", i.packaging]],
    art: [["Artist", i.artist], ["Medium", i.medium], ["Size", i.dimensions], ["Year", i.year],
      ["Signed", i.signed], ["Edition", i.edition]],
  }[i.category] || [];
  rows.push(["Condition", graded ? null : i.condition]);
  if (i.quantity > 1) rows.push(["Quantity", i.quantity]);
  const lines = rows.filter(([, v]) => v != null && v !== "").map(([k, v]) => `${k}: ${v}`);
  if (i.notes) lines.push("", i.notes);
  lines.push("", `SKU: ${i.sku}`);
  return lines.join("\n");
}

function openKit(item) {
  if (!item) return;
  const touch = matchMedia("(pointer: coarse)").matches;
  $("#kit-name").textContent = `${item.sku} · ${item.name}`;
  $("#kit-hint").textContent = !item.photo_count
    ? "No photos yet. Add some from the Photos tab or the item's edit screen."
    : touch
      ? "Press and hold each photo, then choose “Save to Photos” (iPhone) or “Download image” (Android). They'll be in your camera roll, ready to pick in the Whatnot app."
      : "Download the photos to upload in Whatnot's Seller Hub, or open this tracker on your phone to save them straight to your camera roll.";
  $("#kit-photos").innerHTML = item.photos
    .map((p, n) => `<a href="${esc(p.url)}" target="_blank" rel="noopener"><img src="${esc(p.url)}" alt="Photo ${n + 1}"></a>`).join("");
  $("#kit-title").value = listingTitle(item);
  $("#kit-desc").value = listingDescription(item);
  updateKitCount();
  const price = item.list_price ?? item.market_value;
  $("#kit-meta").innerHTML = [
    price != null ? `${item.list_price != null ? "List price" : "Market value"}: <b>${money(price)}</b>` : null,
    price != null ? `Whatnot fees at that price ≈ ${money(whatnotFees(price))}` : null,
    `Cost: ${money(item.total_cost)}`,
  ].filter(Boolean).join(" · ");
  const zip = $("#kit-zip");
  zip.hidden = !item.photo_count;
  zip.href = `/api/items/${item.id}/photos.zip`;
  state.kitItem = item;
  // Load photo files now: browsers only allow sharing right after a tap, with no waiting in between.
  kitFiles = item.photo_count ? photoFiles(item) : Promise.resolve([]);
  if (dialog.open) dialog.close();
  kitDialog.showModal();
}

function updateKitCount() {
  $("#kit-title-count").textContent = `${$("#kit-title").value.length} characters`;
}

async function copyText(text) {
  // navigator.clipboard only works on https/localhost; phones on Wi-Fi use plain http.
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
  // Inside an open dialog everything else is inert, so the helper must live in it.
  (document.querySelector("dialog[open]") || document.body).appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand("copy"); } catch {}
  ta.remove();
  return ok;
}

$("#kit-title").addEventListener("input", updateKitCount);
kitDialog.addEventListener("click", async (e) => {
  const target = e.target.closest("[data-copy]")?.dataset.copy;
  if (!target) return;
  const ok = await copyText($(`#${target}`).value);
  toast(ok ? "Copied. Paste it into Whatnot." : "Couldn't copy automatically. Select the text and copy it.");
});


/* -------------------------------------------------------------- WhatsApp */
// WhatsApp has no official way for an app to post into groups, so the tracker writes
// the post and hands it to WhatsApp; you choose the chat and press send.

const shareDialog = $("#share-dialog");

function listPrice(i) {
  return i.list_price != null ? money(i.list_price) : null;
}

function whatsappItemText(i) {
  const lines = [`*${listingTitle(i)}*`];
  const price = listPrice(i);
  lines.push(price ? `Price: ${price}` : "Price: message me");
  const desc = listingDescription(i).split("\n").filter((l) => l && !l.startsWith("SKU:"));
  lines.push(...desc);
  lines.push(`Ref: ${i.sku}`);
  return lines.join("\n");
}

async function photoFiles(item) {
  const files = [];
  for (const [n, p] of (item.photos || []).entries()) {
    try {
      const blob = await (await fetch(p.url)).blob();
      files.push(new File([blob], `${item.sku || "photo"}-${n + 1}.${blob.type.split("/")[1] || "jpg"}`, { type: blob.type }));
    } catch {}
  }
  return files;
}

function openWhatsApp(text) {
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener");
}


$("#kit-wa-btn").addEventListener("click", async () => {
  const item = state.kitItem;
  if (!item) return;
  const text = whatsappItemText(item);
  const files = await kitFiles;
  if (files.length && navigator.canShare?.({ files })) {
    try {
      await navigator.share({ files, text });
      return;
    } catch (e) {
      if (e.name === "AbortError") return;
    }
  }
  await copyText(text);
  openWhatsApp(text);
  if (files.length) {
    toast("Opening WhatsApp with the text. Attach the photos from your camera roll (use Listing kit to save them).");
  }
});

function stockListText() {
  const items = state.items.filter((i) => i.status === "in_stock" || i.status === "listed");
  const withSku = $("#share-sku").checked;
  const withDetail = $("#share-detail").checked;
  const byCat = { card: [], figure: [], art: [] };
  items.forEach((i) => byCat[i.category]?.push(i));
  const heading = { card: "Cards", figure: "Figures", art: "Art" };
  const out = [`*Available now* (${items.length} item${items.length === 1 ? "" : "s"})`];
  for (const [cat, list] of Object.entries(byCat)) {
    if (!list.length) continue;
    out.push("", `*${heading[cat]}*`);
    for (const i of list) {
      let line = `• ${withDetail ? listingTitle(i) : i.name}`;
      if (withDetail && i.condition && !(i.grader && !/^raw$/i.test(i.grader))) line += ` (${i.condition})`;
      if (i.quantity > 1) line += ` ×${i.quantity}`;
      line += ` — ${listPrice(i) || "make an offer"}`;
      if (withSku) line += `  [${i.sku}]`;
      out.push(line);
    }
  }
  out.push("", "Message me to buy or ask for more photos.");
  return out.join("\n");
}

function openShareList() {
  const count = state.items.filter((i) => i.status === "in_stock" || i.status === "listed").length;
  if (!count) return toast("No unsold items in the current view to share");
  $("#share-hint").textContent =
    `${count} unsold item${count === 1 ? "" : "s"} from the current Inventory view (use the search and filters to narrow it down). ` +
    "Items without a list price say “make an offer”.";
  $("#share-text").value = stockListText();
  shareDialog.showModal();
}

$("#share-list-btn").addEventListener("click", openShareList);
$("#share-sku").addEventListener("change", () => ($("#share-text").value = stockListText()));
$("#share-detail").addEventListener("change", () => ($("#share-text").value = stockListText()));
$("#share-open-btn").addEventListener("click", () => {
  const text = $("#share-text").value;
  if (text.length > 4000) toast("That's a long message. WhatsApp may cut it off, so consider filtering to fewer items.");
  openWhatsApp(text);
});
shareDialog.addEventListener("click", async (e) => {
  const target = e.target.closest("[data-copy]")?.dataset.copy;
  if (!target) return;
  const ok = await copyText($(`#${target}`).value);
  toast(ok ? "Copied. Paste it into any WhatsApp chat." : "Couldn't copy automatically. Select the text and copy it.");
});

/* ---------------------------------------------------------------- Wiring */

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

$$(".tab").forEach((t) => t.addEventListener("click", () => showView(t.dataset.view)));
$("#add-btn").addEventListener("click", () => openItemForm());
$$("[data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
$("#search").addEventListener("input", debounce(loadItems, 200));
$("#filter-category").addEventListener("change", loadItems);
$("#filter-status").addEventListener("change", loadItems);
$("#filter-photos").addEventListener("change", loadItems);
$("#kpis").addEventListener("click", (e) => {
  const view = e.target.closest("[data-goto]")?.dataset.goto;
  if (view) showView(view);
});

$$("#items-table th[data-sort]").forEach((th) =>
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    state.order = state.sort === key && state.order === "desc" ? "asc" : "desc";
    state.sort = key;
    loadItems();
  })
);

$("#items-table tbody").addEventListener("click", (e) => {
  const sellId = e.target.closest("[data-sell]")?.dataset.sell;
  const kitId = e.target.closest("[data-kit]")?.dataset.kit;
  const row = e.target.closest("tr[data-id]");
  if (!row) return;
  const item = state.items.find((i) => String(i.id) === (sellId || kitId || row.dataset.id));
  if (sellId) openSell(item);
  else if (kitId) openKit(item);
  else openItemForm(item);
});

window.addEventListener("resize", debounce(() => { if (!$("#view-dashboard").hidden) loadStats(); }, 250));

initTheme();
let startView = "dashboard";
try { startView = localStorage.getItem("view") || "dashboard"; } catch {}
showView(["inventory", "photos"].includes(startView) ? startView : "dashboard");
