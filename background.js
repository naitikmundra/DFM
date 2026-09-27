
const ENERGY_KWH_PER_GB = 0.06;
const WATER_L_PER_KWH = 0.50;
const CO2E_G_PER_KWH = 400.0;

const MAX_ROWS = 20;
const FLUSH_ALARM = "footprint-flush";

// name of tabs opened across session
const tabHostnames = {};

let pending = {};
let pendingCount = 0;
let flushTimer = null;
let isFlushing = false;


function safeHostname(url) {
  try {
    const u = new URL(url);
    return u.hostname || null;
  } catch (e) {
    return null;
  }
}

function isTrackableUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch (e) {
    return false;
  }
}

function updateTabHostname(tabId, url) {
  if (tabId == null || tabId < 0) return;
  const hostname = safeHostname(url);
  if (hostname) tabHostnames[tabId] = hostname;
}

async function primeTabHostnames() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id != null && tab.url) updateTabHostname(tab.id, tab.url);
    }
  } catch (e) {
    // tabs permission not ready yet / no tabsignore
  }
}

function contentLengthFromHeaders(headers) {
  if (!headers) return 0;
  for (const h of headers) {
    if (h.name && h.name.toLowerCase() === "content-length") {
      const n = parseInt(h.value, 10);
      if (!Number.isNaN(n) && n > 0) return n;
    }
  }
  return 0;
}

function requestBodySize(requestBody) {
  if (!requestBody) return 0;
  let total = 0;
  if (requestBody.raw) {
    for (const part of requestBody.raw) {
      if (part.bytes) total += part.bytes.byteLength;
    }
  }
  if (requestBody.formData) {
    // formData doesn't expose raw byte length; approximate from its
    // serialized size, which is close enough for an estimate model.
    try {
      total += JSON.stringify(requestBody.formData).length;
    } catch (e) {
      // ignore
    }
  }
  return total;
}

function addDelta(hostname, upload, download) {
  if (!hostname) return;
  if (upload <= 0 && download <= 0) return;

  if (!pending[hostname]) pending[hostname] = { upload: 0, download: 0 };
  pending[hostname].upload += upload;
  pending[hostname].download += download;
  pendingCount++;

  if (pendingCount >= 15) {
    flush();
  } else {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 2000);
  }
}

async function flush() {
  if (isFlushing) return;
  if (Object.keys(pending).length === 0) return;

  isFlushing = true;
  const toApply = pending;
  pending = {};
  pendingCount = 0;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  try {
    const stored = await chrome.storage.local.get(["allTimeSites", "allTimeTotals"]);
    const sites = stored.allTimeSites || {};
    const totals = stored.allTimeTotals || { upload: 0, download: 0 };
    const now = Date.now();

    for (const [hostname, d] of Object.entries(toApply)) {
      if (!sites[hostname]) {
        sites[hostname] = { upload: 0, download: 0, firstSeen: now, lastSeen: now };
      }
      sites[hostname].upload += d.upload;
      sites[hostname].download += d.download;
      sites[hostname].lastSeen = now;

      totals.upload += d.upload;
      totals.download += d.download;
    }

    await chrome.storage.local.set({ allTimeSites: sites, allTimeTotals: totals });
  } finally {
    isFlushing = false;
  }
}


function handleBeforeRequest(details) {
  if (details.tabId == null || details.tabId < 0) return;
  if (!isTrackableUrl(details.url)) return;

  const hostname = tabHostnames[details.tabId] || safeHostname(details.url);
  const bytes = requestBodySize(details.requestBody);
  if (bytes > 0) addDelta(hostname, bytes, 0);
}

function handleCompleted(details) {
  if (details.tabId == null || details.tabId < 0) return;
  if (!isTrackableUrl(details.url)) return;

  const hostname = tabHostnames[details.tabId] || safeHostname(details.url);
  const bytes = contentLengthFromHeaders(details.responseHeaders);
  if (bytes > 0) addDelta(hostname, 0, bytes);
}

chrome.webRequest.onBeforeRequest.addListener(
  handleBeforeRequest,
  { urls: ["<all_urls>"] },
  ["requestBody"]
);

chrome.webRequest.onCompleted.addListener(
  handleCompleted,
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);


chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    updateTabHostname(tabId, changeInfo.url);
  } else if (tab && tab.url) {
    updateTabHostname(tabId, tab.url);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabHostnames[tabId];
});

async function getActiveHostname() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) return safeHostname(tab.url);
  } catch (e) {
    // ignore
  }
  return null;
}


async function snapshotSessionBaseline() {
  const stored = await chrome.storage.local.get(["allTimeSites", "allTimeTotals"]);
  await chrome.storage.local.set({
    sessionBaselineSites: JSON.parse(JSON.stringify(stored.allTimeSites || {})),
    sessionBaselineTotals: { ...(stored.allTimeTotals || { upload: 0, download: 0 }) },
    sessionStartedAt: Date.now(),
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  await primeTabHostnames();
  const stored = await chrome.storage.local.get(["allTimeSites", "allTimeTotals", "installedAt"]);
  const updates = {};
  if (!stored.installedAt) updates.installedAt = Date.now();
  if (!stored.allTimeSites) updates.allTimeSites = {};
  if (!stored.allTimeTotals) updates.allTimeTotals = { upload: 0, download: 0 };
  if (Object.keys(updates).length) await chrome.storage.local.set(updates);
  await snapshotSessionBaseline();
});


chrome.runtime.onStartup.addListener(async () => {
  await primeTabHostnames();
  await snapshotSessionBaseline();
});

chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === FLUSH_ALARM) flush();
});

chrome.runtime.onSuspend.addListener(() => {
  flush();
});



function computeImpact(totalBytes) {
  const gb = totalBytes / 1024 ** 3;
  const energy = gb * ENERGY_KWH_PER_GB;
  return {
    energy_kwh: energy,
    water_l: energy * WATER_L_PER_KWH,
    co2_g: energy * CO2E_G_PER_KWH,
  };
}

function mergePendingSites(sitesMap) {
  const merged = {};
  for (const [h, v] of Object.entries(sitesMap)) merged[h] = { ...v };
  for (const [h, d] of Object.entries(pending)) {
    if (!merged[h]) merged[h] = { upload: 0, download: 0, lastSeen: Date.now() };
    merged[h].upload += d.upload;
    merged[h].download += d.download;
    merged[h].lastSeen = Date.now();
  }
  return merged;
}

function mergePendingTotals(totals) {
  let upload = totals.upload;
  let download = totals.download;
  for (const d of Object.values(pending)) {
    upload += d.upload;
    download += d.download;
  }
  return { upload, download };
}

function buildBucket(totals, sitesMap, since) {
  const totalBytes = totals.upload + totals.download;
  const impact = computeImpact(totalBytes);

  let sites = Object.entries(sitesMap).map(([hostname, s]) => {
    const total = s.upload + s.download;
    const siteImpact = computeImpact(total);
    return {
      hostname,
      upload_bytes: s.upload,
      download_bytes: s.download,
      total_bytes: total,
      energy_kwh: siteImpact.energy_kwh,
      water_l: siteImpact.water_l,
      co2_g: siteImpact.co2_g,
      last_seen: s.lastSeen || null,
    };
  });

  sites.sort((a, b) => b.total_bytes - a.total_bytes);
  sites = sites.slice(0, MAX_ROWS);

  const maxTotal = sites.reduce((m, s) => Math.max(m, s.total_bytes), 0) || 1;
  sites.forEach((s) => {
    s.share = s.total_bytes / maxTotal;
  });

  return {
    since,
    elapsed_seconds: Math.max(0, (Date.now() - since) / 1000),
    upload_bytes: totals.upload,
    download_bytes: totals.download,
    total_bytes: totalBytes,
    energy_kwh: impact.energy_kwh,
    water_l: impact.water_l,
    co2_g: impact.co2_g,
    sites,
  };
}

async function buildSnapshot() {
  const stored = await chrome.storage.local.get([
    "allTimeSites",
    "allTimeTotals",
    "sessionBaselineSites",
    "sessionBaselineTotals",
    "sessionStartedAt",
    "installedAt",
  ]);

  const allTimeSites = mergePendingSites(stored.allTimeSites || {});
  const allTimeTotals = mergePendingTotals(stored.allTimeTotals || { upload: 0, download: 0 });

  const baselineSites = stored.sessionBaselineSites || {};
  const baselineTotals = stored.sessionBaselineTotals || { upload: 0, download: 0 };
  const sessionStartedAt = stored.sessionStartedAt || Date.now();

  const sessionTotals = {
    upload: Math.max(0, allTimeTotals.upload - baselineTotals.upload),
    download: Math.max(0, allTimeTotals.download - baselineTotals.download),
  };

  const sessionSites = {};
  for (const [host, stats] of Object.entries(allTimeSites)) {
    const base = baselineSites[host] || { upload: 0, download: 0 };
    const up = Math.max(0, stats.upload - base.upload);
    const down = Math.max(0, stats.download - base.download);
    if (up > 0 || down > 0) {
      sessionSites[host] = { upload: up, download: down, lastSeen: stats.lastSeen };
    }
  }

  const activeHostname = await getActiveHostname();

  return {
    generated_at: Date.now(),
    active_hostname: activeHostname,
    coefficients: {
      energy_kwh_per_gb: ENERGY_KWH_PER_GB,
      water_l_per_kwh: WATER_L_PER_KWH,
      co2e_g_per_kwh: CO2E_G_PER_KWH,
    },
    session: buildBucket(sessionTotals, sessionSites, sessionStartedAt),
    all_time: buildBucket(allTimeTotals, allTimeSites, stored.installedAt || sessionStartedAt),
  };
}

async function resetAllTime() {
  pending = {};
  pendingCount = 0;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await chrome.storage.local.set({
    allTimeSites: {},
    allTimeTotals: { upload: 0, download: 0 },
    installedAt: Date.now(),
  });
  await snapshotSessionBaseline();
}


chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;

  if (msg.type === "GET_SNAPSHOT") {
    buildSnapshot().then(sendResponse);
    return true; // keep the message channel open for the async response
  }

  if (msg.type === "RESET_ALL_TIME") {
    resetAllTime().then(() => sendResponse({ ok: true }));
    return true;
  }

  return false;
});
