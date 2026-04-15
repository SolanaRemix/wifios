'use strict';

// CSRF token is stored in sessionStorage after login
let csrfToken = sessionStorage.getItem('csrfToken') || '';

// ──────────────────────────────────────────────
// Navigation
// ──────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    const pageId = 'page-' + btn.dataset.page;
    const page = document.getElementById(pageId);
    if (page) page.classList.add('active');
    refreshPage(btn.dataset.page);
  });
});

function refreshPage(name) {
  switch (name) {
    case 'overview':  loadOverview();  break;
    case 'devices':   loadDevices();   break;
    case 'payments':  loadPayments();  break;
    case 'vouchers':  loadVouchers();  break;
    case 'qr':        /* on demand */  break;
  }
}

// ──────────────────────────────────────────────
// Toast
// ──────────────────────────────────────────────
function toast(msg, color) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.color = color || 'var(--text)';
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 3000);
}

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────
function fmtTime(seconds) {
  if (!seconds && seconds !== 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function statusBadge(status) {
  const map = {
    active:    'badge-active',
    blocked:   'badge-blocked',
    expired:   'badge-expired',
    pending:   'badge-pending',
    confirmed: 'badge-confirmed',
  };
  return `<span class="badge ${map[status] || ''}">${escapeHtml(status)}</span>`;
}

/** Escape HTML special characters to prevent XSS in innerHTML. */
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function apiFetch(url, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const safeMethod = method === 'GET' || method === 'HEAD';
  const res = await fetch(url, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      ...(!safeMethod ? { 'X-CSRF-Token': csrfToken } : {}),
    },
  });
  if (res.status === 401) {
    window.location.href = '/login.html';
    return null;
  }
  return res;
}

// ──────────────────────────────────────────────
// Chart.js revenue chart (persisted across refreshes)
// ──────────────────────────────────────────────
let revenueChart = null;

function renderRevenueChart(hourlyRevenue) {
  const canvas = document.getElementById('revenueChart');
  if (!canvas) return;
  const labels  = hourlyRevenue.map((r) => r.hour || '');
  const values  = hourlyRevenue.map((r) => r.revenue || 0);

  if (revenueChart) {
    revenueChart.data.labels = labels;
    revenueChart.data.datasets[0].data = values;
    revenueChart.update('none');
    return;
  }

  revenueChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Revenue (₱)',
        data: values,
        backgroundColor: 'rgba(124,58,237,0.6)',
        borderColor:     'rgba(124,58,237,1)',
        borderWidth: 1,
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: '#8b949e', font: { size: 11 } } },
        tooltip: { callbacks: { label: (c) => ` ₱${c.raw.toFixed(2)}` } },
      },
      scales: {
        x: { ticks: { color: '#8b949e', font: { size: 10 } }, grid: { color: '#30363d' } },
        y: { ticks: { color: '#8b949e' }, grid: { color: '#30363d' }, beginAtZero: true },
      },
    },
  });
}

// ──────────────────────────────────────────────
// Overview
// ──────────────────────────────────────────────
async function loadOverview() {
  const res = await apiFetch('/analytics');
  if (!res) return;
  const data = await res.json();
  applyStats(data);
}

function applyStats(data) {
  document.getElementById('st-total').textContent   = data.totalUsers;
  document.getElementById('st-active').textContent  = data.activeUsers;
  document.getElementById('st-expired').textContent = data.expiredUsers;
  document.getElementById('st-blocked').textContent = data.blockedUsers;
  document.getElementById('st-revenue').textContent = '₱' + Number(data.totalRevenue).toFixed(2);

  renderRevenueChart(data.hourlyRevenue || []);

  // Recent payments
  const tbody = document.getElementById('recentTable');
  if (!tbody) return;
  tbody.innerHTML = (data.recentPayments || []).map((p) => `
    <tr>
      <td style="font-family:monospace;font-size:0.8rem">${escapeHtml(p.ref)}</td>
      <td style="font-family:monospace">${escapeHtml(p.mac)}</td>
      <td>₱${escapeHtml(String(p.amount))}</td>
      <td>${fmtTime(p.time_grant)}</td>
      <td style="color:var(--muted);font-size:0.8rem">${escapeHtml(new Date(p.created_at).toLocaleString())}</td>
    </tr>`).join('') || '<tr><td colspan="5" style="color:var(--muted);text-align:center;padding:1rem">No payments yet</td></tr>';
}

// ──────────────────────────────────────────────
// System Health
// ──────────────────────────────────────────────
async function loadSystemHealth() {
  try {
    const res = await apiFetch('/system');
    if (!res || !res.ok) return;
    const d = await res.json();
    const cpuEl  = document.getElementById('sys-cpu');
    const memEl  = document.getElementById('sys-mem');
    const diskEl = document.getElementById('sys-disk');
    if (cpuEl)  cpuEl.textContent  = d.cpu.load + '%';
    if (memEl)  memEl.textContent  = d.memory.usedPercent + '%';
    if (diskEl && d.disk && d.disk.length) {
      diskEl.textContent = d.disk[0].usedPercent + '%';
    }
  } catch (_) { /* non-fatal */ }
}

// ──────────────────────────────────────────────
// WebSocket — live push from server
// ──────────────────────────────────────────────
const wsUrl = `ws://${location.host}/ws`;
let ws;
const wsEl = document.getElementById('ws-status');

function connectWS() {
  ws = new WebSocket(wsUrl);

  ws.addEventListener('open', () => {
    if (wsEl) { wsEl.textContent = '🟢 Live'; wsEl.style.color = 'var(--green)'; }
  });

  ws.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'stats') {
        applyStats(msg.payload.stats);
        // Also refresh devices table if it's the active page
        const activePage = document.querySelector('.nav-item.active');
        if (activePage && activePage.dataset.page === 'devices' && msg.payload.users) {
          renderDevices(msg.payload.users);
        }
      }
    } catch (_) {}
  });

  ws.addEventListener('close', () => {
    if (wsEl) { wsEl.textContent = '🔴 Offline'; wsEl.style.color = 'var(--red)'; }
    // Reconnect after 5 s
    setTimeout(connectWS, 5000);
  });

  ws.addEventListener('error', () => ws.close());
}

connectWS();

// ──────────────────────────────────────────────
// Devices
// ──────────────────────────────────────────────
async function loadDevices() {
  const res = await apiFetch('/users');
  if (!res) return;
  const users = await res.json();
  renderDevices(users);
}

function renderDevices(users) {
  const tbody = document.getElementById('devicesTable');
  if (!tbody) return;
  tbody.innerHTML = users.map((u) => `
    <tr>
      <td style="font-family:monospace">${escapeHtml(u.mac)}</td>
      <td>${escapeHtml(u.ip || '—')}</td>
      <td>${statusBadge(u.status)}</td>
      <td>${fmtTime(u.time_left)}</td>
      <td>
        <button class="btn btn-red"   data-action="block" data-mac="${escapeHtml(u.mac)}">🔒 Block</button>
        <button class="btn btn-green" data-action="allow" data-mac="${escapeHtml(u.mac)}">🔓 Allow</button>
      </td>
    </tr>`).join('') ||
    '<tr><td colspan="5" style="color:var(--muted);text-align:center;padding:1rem">No devices detected yet</td></tr>';
}

// Event delegation for device block/allow buttons — avoids inline onclick handlers
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const mac = btn.dataset.mac;
  if (btn.dataset.action === 'block') blockDevice(mac);
  if (btn.dataset.action === 'allow') allowDevice(mac);
});

async function blockDevice(mac) {
  const res = await apiFetch(`/block/${encodeURIComponent(mac)}`, { method: 'POST' });
  if (!res) return;
  const data = await res.json();
  if (res.ok) { toast('🔒 Device blocked', 'var(--red)'); loadDevices(); }
  else toast(data.error, 'var(--red)');
}

async function allowDevice(mac) {
  const res = await apiFetch(`/allow/${encodeURIComponent(mac)}`, { method: 'POST' });
  if (!res) return;
  const data = await res.json();
  if (res.ok) { toast('🔓 Device allowed', 'var(--green)'); loadDevices(); }
  else toast(data.error, 'var(--red)');
}

// ──────────────────────────────────────────────
// Payments
// ──────────────────────────────────────────────
async function loadPayments() {
  const res = await apiFetch('/payments');
  if (!res) return;
  const payments = await res.json();
  const tbody = document.getElementById('paymentsTable');
  tbody.innerHTML = payments.map((p) => `
    <tr>
      <td style="font-family:monospace;font-size:0.8rem">${escapeHtml(p.ref)}</td>
      <td style="font-family:monospace">${escapeHtml(p.mac)}</td>
      <td>₱${escapeHtml(String(p.amount))}</td>
      <td>${fmtTime(p.time_grant)}</td>
      <td>${statusBadge(p.status)}</td>
      <td style="color:var(--muted);font-size:0.8rem">${escapeHtml(new Date(p.created_at).toLocaleString())}</td>
    </tr>`).join('') ||
    '<tr><td colspan="6" style="color:var(--muted);text-align:center;padding:1rem">No payments yet</td></tr>';
}

document.getElementById('confirmBtn').addEventListener('click', async () => {
  const ref = document.getElementById('confirmRef').value.trim();
  if (!ref) { toast('Enter a payment ref.', 'var(--yellow)'); return; }
  const res = await apiFetch('/confirm-payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref }),
  });
  if (!res) return;
  const data = await res.json();
  if (res.ok) {
    toast('✅ Payment confirmed!', 'var(--green)');
    document.getElementById('confirmRef').value = '';
    loadPayments();
  } else {
    toast(data.error || 'Error', 'var(--red)');
  }
});

// ──────────────────────────────────────────────
// Vouchers
// ──────────────────────────────────────────────
async function loadVouchers() {
  const res = await apiFetch('/vouchers');
  if (!res) return;
  const vouchers = await res.json();
  const tbody = document.getElementById('vouchersTable');
  tbody.innerHTML = vouchers.map((v) => `
    <tr>
      <td style="font-family:monospace;font-weight:700">${escapeHtml(v.code)}</td>
      <td>${fmtTime(v.time_grant)}</td>
      <td>${v.used ? '<span style="color:var(--muted)">Used</span>' : '<span style="color:var(--green)">Available</span>'}</td>
      <td style="color:var(--muted);font-size:0.8rem">${new Date(v.created_at).toLocaleString()}</td>
    </tr>`).join('') ||
    '<tr><td colspan="4" style="color:var(--muted);text-align:center;padding:1rem">No vouchers yet</td></tr>';
}

document.getElementById('genVoucherBtn').addEventListener('click', async () => {
  const time = document.getElementById('voucherTime').value;
  const res = await apiFetch('/voucher/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ time }),
  });
  if (!res) return;
  const data = await res.json();
  if (res.ok) {
    const el = document.getElementById('voucherResult');
    el.textContent = `✅ Voucher: ${data.code} (${fmtTime(data.time)})`;
    el.style.display = 'block';
    toast('🎟 Voucher created!', 'var(--green)');
    loadVouchers();
  } else {
    toast(data.error || 'Error', 'var(--red)');
  }
});

// ──────────────────────────────────────────────
// QR Code
// ──────────────────────────────────────────────
document.getElementById('loadQrBtn').addEventListener('click', async () => {
  const res = await apiFetch('/qr');
  if (!res) return;
  const data = await res.json();
  if (res.ok) {
    const img = document.getElementById('qrImg');
    img.src = data.qr;
    img.style.display = 'block';
    document.getElementById('qrUrl').textContent = data.url;
  } else {
    toast(data.error || 'Error loading QR', 'var(--red)');
  }
});

// ──────────────────────────────────────────────
// Logout
// ──────────────────────────────────────────────
document.getElementById('logoutBtn').addEventListener('click', async () => {
  await apiFetch('/logout', { method: 'POST' });
  window.location.href = '/login.html';
});

// ──────────────────────────────────────────────
// Initial load & periodic refresh (fallback when WS not connected)
// ──────────────────────────────────────────────
loadOverview();
loadSystemHealth();

setInterval(() => {
  const activePage = document.querySelector('.nav-item.active');
  if (activePage) refreshPage(activePage.dataset.page);
}, 15000); // slower poll — WS handles real-time

setInterval(loadSystemHealth, 10000);
