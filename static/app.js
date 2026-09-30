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

const state = { sort: "updated_at", order: "desc", items: [], editing: null, selling: null, pendingPhoto: undefined };

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
  else loadItems();
}

function refresh() {
  if (!$("#view-dashboard").hidden) loadStats();
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
  ];
  $("#kpis").innerHTML = tiles
    .map(([label, value, sub, cls]) =>
      `<div class="kpi"><div class="label">${label}</div><div class="value ${cls || ""}">${value}</div><div class="sub">${esc(sub)}</div></div>`)
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
    const thumb = i.photo_url
      ? `<img class="thumb" src="${esc(i.photo_url)}" alt="" loading="lazy">`
      : `<div class="thumb none">${CAT_LABEL[i.category][0]}</div>`;
    const value = i.list_price != null
      ? `${money(i.list_price)}<div class="sub">${i.market_value != null ? `mkt ${money(i.market_value)}` : "list"}</div>`
      : money(i.market_value);
    const sold = i.status === "sold"
      ? `${money(i.sale_price)}<div class="sub ${signed(i.profit)}">${i.profit >= 0 ? "+" : ""}${money(i.profit)}</div>`
      : "";
    const actions = i.status === "sold" ? "" : `<button class="btn small" data-sell="${i.id}">Sell</button>`;
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

function setPhotoPreview(url) {
  const img = $("#photo-preview");
  img.hidden = !url;
  if (url) img.src = url;
  $("#photo-remove").hidden = !url;
}

function openItemForm(item = null) {
  form.reset();
  state.editing = item;
  state.pendingPhoto = undefined;
  $("#photo-input").value = "";
  $("#form-error").hidden = true;
  $("#item-dialog-title").textContent = item ? `Edit ${item.sku || "item"}` : "Add item";
  $("#delete-btn").hidden = !item;
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
  setPhotoPreview(item?.photo_url);
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

async function resizeImage(file, maxSize = 1400) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.86);
}

form.addEventListener("change", (e) => {
  if (e.target.name === "category") setCategory(e.target.value);
  if (e.target.name === "status") toggleSaleSection();
});

$("#photo-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    state.pendingPhoto = await resizeImage(file);
    setPhotoPreview(state.pendingPhoto);
  } catch {
    toast("Couldn't read that image");
  }
});

$("#photo-remove").addEventListener("click", () => {
  state.pendingPhoto = null;
  $("#photo-input").value = "";
  setPhotoPreview(null);
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = formData(form);
  try {
    let item = state.editing
      ? await api(`/api/items/${state.editing.id}`, { method: "PUT", body: data })
      : await api("/api/items", { method: "POST", body: data });
    if (state.pendingPhoto) {
      item = await api(`/api/items/${item.id}/photo`, { method: "POST", body: { data: state.pendingPhoto } });
    } else if (state.pendingPhoto === null && state.editing?.photo) {
      item = await api(`/api/items/${item.id}/photo`, { method: "DELETE" });
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
  f.sale_platform.value = item.listed_platform ?? "";
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
  const qty = Math.min(Math.max(parseInt(f.quantity.value, 10) || item.quantity, 1), item.quantity);
  const cost = item.total_cost * (qty / item.quantity);
  const profit = num(f.sale_price.value) - cost - num(f.fees.value) - num(f.shipping_out.value);
  $("#sell-preview").innerHTML = `Estimated profit: <b class="${signed(profit)}">${money(profit)}</b>` +
    (qty < item.quantity ? ` · ${item.quantity - qty} will stay in stock` : "");
}

sellForm.addEventListener("input", updateSellPreview);
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
  const row = e.target.closest("tr[data-id]");
  if (!row) return;
  const item = state.items.find((i) => String(i.id) === (sellId || row.dataset.id));
  if (sellId) openSell(item);
  else openItemForm(item);
});

window.addEventListener("resize", debounce(() => { if (!$("#view-dashboard").hidden) loadStats(); }, 250));

initTheme();
let startView = "dashboard";
try { startView = localStorage.getItem("view") || "dashboard"; } catch {}
showView(startView === "inventory" ? "inventory" : "dashboard");
