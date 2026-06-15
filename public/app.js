let stripe, elements, cardElement;
let currentUser = null;
let selected = null; // { month, day }
let myClaims = {}; // key "m-d" -> { amount }

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

async function init() {
  const configRes = await fetch('/api/config');
  const config = await configRes.json();
  stripe = Stripe(config.publishableKey);

  const meRes = await fetch('/auth/me');
  const me = await meRes.json();
  currentUser = me.user;

  renderAuthBar();

  if (currentUser) {
    document.getElementById('authForms').classList.add('hidden');
    document.getElementById('calendarSection').classList.remove('hidden');
    await loadCalendar();
    await loadMyClaims();
  } else {
    document.getElementById('authForms').classList.remove('hidden');
    document.getElementById('calendarSection').classList.add('hidden');
  }
}

function renderAuthBar() {
  const bar = document.getElementById('authBar');
  if (currentUser) {
    bar.innerHTML = `<span>${currentUser.email}</span> <button id="logoutBtn">Log out</button>`;
    document.getElementById('logoutBtn').addEventListener('click', async () => {
      await fetch('/auth/logout', { method: 'POST' });
      currentUser = null;
      location.reload();
    });
  } else {
    bar.innerHTML = '';
  }
}

// --- Auth ---

document.getElementById('signupBtn').addEventListener('click', () => authAction('/auth/signup'));
document.getElementById('loginBtn').addEventListener('click', () => authAction('/auth/login'));

async function authAction(url) {
  const email = document.getElementById('emailInput').value;
  const password = document.getElementById('passwordInput').value;
  const errEl = document.getElementById('authError');
  errEl.classList.add('hidden');

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();

  if (!res.ok) {
    errEl.textContent = data.error || 'Something went wrong';
    errEl.classList.remove('hidden');
    return;
  }

  location.reload();
}

// --- Calendar ---

async function loadCalendar() {
  const res = await fetch('/api/calendar');
  const data = await res.json();

  myClaims = {};
  data.claims.forEach((c) => { myClaims[`${c.month}-${c.day}`] = c; });

  renderCalendar();
  renderForm();
}

function renderCalendar() {
  const grid = document.getElementById('grid');
  grid.innerHTML = '';

  for (let m = 1; m <= 12; m++) {
    const monthBlock = document.createElement('div');
    monthBlock.className = 'month-block';

    const heading = document.createElement('h3');
    heading.className = 'month-heading';
    heading.textContent = MONTH_NAMES[m - 1];
    monthBlock.appendChild(heading);

    const monthGrid = document.createElement('div');
    monthGrid.className = 'month-grid';

    const daysInMonth = DAYS_IN_MONTH[m - 1];
    for (let d = 1; d <= daysInMonth; d++) {
      const key = `${m}-${d}`;
      const claim = myClaims[key];

      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.innerHTML = `<span class="day-num">${d}</span><span class="day-amt">$${d}</span>`;

      if (claim) {
        cell.classList.add('mine');
        cell.title = `Donated $${claim.amount}`;
      } else {
        if (selected && selected.month === m && selected.day === d) cell.classList.add('selected');
        cell.addEventListener('click', () => {
          selected = { month: m, day: d };
          renderCalendar();
          renderForm();
        });
      }

      monthGrid.appendChild(cell);
    }

    monthBlock.appendChild(monthGrid);
    grid.appendChild(monthBlock);
  }
}

// --- Claim form ---

async function renderForm() {
  const area = document.getElementById('formArea');

  if (!selected) {
    area.innerHTML = `<p style="color:#888;font-size:14px;">Select a date on your calendar to donate that amount (e.g. the 15th = $15).</p>`;
    cardElement = null;
    return;
  }

  const { month, day } = selected;

  area.innerHTML = `
    <div class="card">
      <strong>${MONTH_NAMES[month - 1]} ${day}</strong>
      <p style="margin: 6px 0 12px;">Donation amount: <strong>$${day}</strong></p>
      <label>Card details</label>
      <div id="card-element"></div>
      <p id="claimError" class="error hidden"></p>
      <button id="claimBtn">Donate $${day} and fill this date</button>
    </div>
  `;

  elements = stripe.elements();
  cardElement = elements.create('card');
  cardElement.mount('#card-element');

  document.getElementById('claimBtn').addEventListener('click', submitClaim);
}

async function submitClaim() {
  const errEl = document.getElementById('claimError');
  const btn = document.getElementById('claimBtn');
  const originalLabel = btn.textContent;
  errEl.classList.add('hidden');

  btn.disabled = true;
  btn.textContent = 'Processing payment...';

  try {
    const { paymentMethod, error: pmError } = await stripe.createPaymentMethod({
      type: 'card',
      card: cardElement,
    });

    if (pmError) throw new Error(pmError.message);

    const body = { month: selected.month, day: selected.day, paymentMethodId: paymentMethod.id };

    const claimRes = await fetch('/api/claims', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const claimData = await claimRes.json();

    if (!claimRes.ok) {
      if (claimData.requiresAction && claimData.clientSecret) {
        const { error: confirmError } = await stripe.confirmCardPayment(claimData.clientSecret);
        if (confirmError) throw new Error(confirmError.message);
        const retryRes = await fetch('/api/claims', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const retryData = await retryRes.json();
        if (!retryRes.ok) throw new Error(retryData.error || 'Failed to complete donation');
      } else {
        throw new Error(claimData.error || 'Failed to complete donation');
      }
    }

    selected = null;
    await loadCalendar();
    await loadMyClaims();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

// --- My claims ---

async function loadMyClaims() {
  const res = await fetch('/api/my-claims');
  const data = await res.json();
  const el = document.getElementById('myClaims');

  const totalEl = document.getElementById('myTotal');
  if (totalEl) totalEl.textContent = `$${data.total}`;

  if (data.claims.length === 0) {
    el.innerHTML = '<p style="color:#888;font-size:14px;">No donations yet.</p>';
    return;
  }

  el.innerHTML = data.claims.map((c) => `
    <div class="claim-row">
      <span>${MONTH_NAMES[c.month - 1]} ${c.day} &mdash; $${c.amount}</span>
      <span class="status-badge status-CHARGED">Donated</span>
    </div>
  `).join('');
}

init();
