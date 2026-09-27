const POLL_MS = 1500;
let currentView = "session"; // "session" | "all_time"
let lastSnapshot = null;
let lastGoodUpdate = null;

function humanBytes(value) {
  const units = ["B", "KB", "MB", "GB", "TB"]; //higher not req i gues
  let v = Number(value) || 0;
  for (const unit of units) {
    if (v < 1024) return `${v.toFixed(1)} ${unit}`;
    v /= 1024;
  }
  return `${v.toFixed(1)} PB`;
}

function humanTime(seconds) {
  seconds = Math.max(0, Math.floor(seconds));
  const days = Math.floor(seconds / 86400);
  seconds %= 86400;
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;

  if (days) return `${days}d ${String(hours).padStart(2, "0")}h`;
  if (hours) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function co2Color(grams) {
  if (grams < 1) return "var(--carbon)";
  if (grams < 10) return "var(--energy)";
  return "var(--carbon-high)";
}

function setLive(isLive) {
  document.getElementById("liveDot").classList.toggle("offline", !isLive);
}

function renderSites(sites) {
  const container = document.getElementById("siteList");

  if (!sites.length) {
    container.innerHTML = '<div class="empty-state">Waiting for traffic&hellip;</div>';
    return;
  }

  container.innerHTML = sites.map(site => `
    <div class="site-row" style="--share: ${(site.share * 100).toFixed(1)}%">
      <div class="site-name" title="${site.hostname}">${site.hostname}</div>
      <div class="num">${humanBytes(site.download_bytes)}</div>
      <div class="num">${humanBytes(site.upload_bytes)}</div>
      <div class="co2" style="color: ${co2Color(site.co2_g)}">${site.co2_g.toFixed(2)}g</div>
    </div>
  `).join("");
}

function renderBucket(bucket) {
  document.getElementById("elapsedLabel").textContent =
    currentView === "session" ? "since Chrome start" : "since install";
  document.getElementById("elapsed").textContent = humanTime(bucket.elapsed_seconds);

  document.getElementById("download").textContent = humanBytes(bucket.download_bytes);
  document.getElementById("upload").textContent = humanBytes(bucket.upload_bytes);
  document.getElementById("total").textContent = humanBytes(bucket.total_bytes);

  document.getElementById("energy").textContent = bucket.energy_kwh.toFixed(4);
  document.getElementById("water").textContent = bucket.water_l.toFixed(3);
  document.getElementById("co2").textContent = bucket.co2_g.toFixed(2);

  const maxTotal = Math.max(bucket.total_bytes, ...bucket.sites.map(s => s.total_bytes), 1);
  const pct = Math.min(100, (bucket.total_bytes / maxTotal) * 100);
  document.getElementById("energyFill").style.width = `${pct}%`;
  document.getElementById("waterFill").style.width = `${pct}%`;
  document.getElementById("co2Fill").style.width = `${pct}%`;

  renderSites(bucket.sites);
}

function render(snapshot) {
  lastSnapshot = snapshot;

  document.getElementById("activeHost").textContent = snapshot.active_hostname || "—";

  const c = snapshot.coefficients;
  document.getElementById("formulaNote").textContent =
    `Energy = GB × ${c.energy_kwh_per_gb} kWh/GB | Water = Energy × ${c.water_l_per_kwh} L/kWh | CO₂e = Energy × ${c.co2e_g_per_kwh} g/kWh`;

  const bucket = currentView === "session" ? snapshot.session : snapshot.all_time;
  renderBucket(bucket);

  const allTime = snapshot.all_time;
  document.getElementById("footerNote").textContent =
    `all-time total: ${humanBytes(allTime.total_bytes)} · ${allTime.co2_g.toFixed(1)}g CO₂e`;

  lastGoodUpdate = new Date();
  setLive(true);
}

async function poll() {
  try {
    const snapshot = await chrome.runtime.sendMessage({ type: "GET_SNAPSHOT" });
    if (!snapshot) throw new Error("empty snapshot");
    render(snapshot);
  } catch (err) {
    setLive(false);
    document.getElementById("footerNote").textContent = lastGoodUpdate
      ? `connection lost — last update ${lastGoodUpdate.toLocaleTimeString()}`
      : "waiting for the extension's background worker…";
  }
}

function setView(view) {
  currentView = view;
  document.getElementById("btnSession").classList.toggle("active", view === "session");
  document.getElementById("btnAllTime").classList.toggle("active", view === "all_time");
  if (lastSnapshot) renderBucket(view === "session" ? lastSnapshot.session : lastSnapshot.all_time);
}

document.getElementById("btnSession").addEventListener("click", () => setView("session"));
document.getElementById("btnAllTime").addEventListener("click", () => setView("all_time"));

document.getElementById("resetBtn").addEventListener("click", async () => {
  if (!confirm("Clear all-time website history? This cannot be undone.")) return;
  await chrome.runtime.sendMessage({ type: "RESET_ALL_TIME" });
  poll();
});

poll();
setInterval(poll, POLL_MS);
