'use strict';

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
  return `<span class="badge ${map[status] || ''}">${status}</span>`;
}

async function apiFetch(url, opts = {}) {
  const res = await fetch(url, opts);
  if (res.status === 401) {
    window.location.href = '/login.html';
    return null;
  }
  return res;
}

// ──────────────────────────────────────────────
// Overview
// ──────────────────────────────────────────────
async function loadOverview() {
  const res = await apiFetch('/analytics');
  if (!res) return;
  const data = await res.json();

  document.getElementById('st-total').textContent   = data.totalUsers;
  document.getElementById('st-active').textContent  = data.activeUsers;
  document.getElementById('st-expired').textContent = data.expiredUsers;
  document.getElementById('st-blocked').textContent = data.blockedUsers;
  document.getElementById('st-revenue').textContent = '₱' + Number(data.totalRevenue).toFixed(2);

  // Chart
  const chart = document.getElementById('revenueChart');
  chart.innerHTML = '';
  const maxRev = Math.max(...data.hourlyRevenue.map((r) => r.revenue), 1);
  data.hourlyRevenue.forEach((r) => {
    const pct = Math.round((r.revenue / maxRev) * 100);
    chart.innerHTML += `
      <div class="bar-wrap">
        <div class="bar" style="height:${pct}px"></div>
        <div class="bar-label">${r.hour || ''}</div>
      </div>`;
  });
  if (!data.hourlyRevenue.length) {
    chart.innerHTML = '<p style="color:var(--muted);font-size:0.85rem">No data yet.</p>';
  }

  // Recent payments
  const tbody = document.getElementById('recentTable');
  tbody.innerHTML = data.recentPayments.map((p) => `
    <tr>
      <td style="font-family:monospace;font-size:0.8rem">${p.ref}</td>
      <td style="font-family:monospace">${p.mac}</td>
      <td>₱${p.amount}</td>
      <td>${fmtTime(p.time_grant)}</td>
      <td style="color:var(--muted);font-size:0.8rem">${new Date(p.created_at).toLocaleString()}</td>
    </tr>`).join('') || '<tr><td colspan="5" style="color:var(--muted);text-align:center;padding:1rem">No payments yet</td></tr>';
}

// ──────────────────────────────────────────────
// Devices
// ──────────────────────────────────────────────
async function loadDevices() {
  const res = await apiFetch('/users');
  if (!res) return;
  const users = await res.json();
  const tbody = document.getElementById('devicesTable');
  tbody.innerHTML = users.map((u) => `
    <tr>
      <td style="font-family:monospace">${u.mac}</td>
      <td>${u.ip || '—'}</td>
      <td>${statusBadge(u.status)}</td>
      <td>${fmtTime(u.time_left)}</td>
      <td>
        <button class="btn btn-red"   onclick="blockDevice('${u.mac}')">🔒 Block</button>
        <button class="btn btn-green" onclick="allowDevice('${u.mac}')">🔓 Allow</button>
      </td>
    </tr>`).join('') ||
    '<tr><td colspan="5" style="color:var(--muted);text-align:center;padding:1rem">No devices detected yet</td></tr>';
}

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
      <td style="font-family:monospace;font-size:0.8rem">${p.ref}</td>
      <td style="font-family:monospace">${p.mac}</td>
      <td>₱${p.amount}</td>
      <td>${fmtTime(p.time_grant)}</td>
      <td>${statusBadge(p.status)}</td>
      <td style="color:var(--muted);font-size:0.8rem">${new Date(p.created_at).toLocaleString()}</td>
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
      <td style="font-family:monospace;font-weight:700">${v.code}</td>
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
// Auto-refresh
// ──────────────────────────────────────────────
loadOverview(); // initial load

setInterval(() => {
  const activePage = document.querySelector('.nav-item.active');
  if (activePage) refreshPage(activePage.dataset.page);
}, 5000);
