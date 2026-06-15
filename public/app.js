let stripe, elements, cardElement;
let currentUser = null;
let viewYear, viewMonth; // viewMonth is 1-12
let selectedDate = null;
let monthClaims = {};

const today = new Date();
viewYear = today.getFullYear();
viewMonth = today.getMonth() + 1;

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
    await loadMonth();
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

document.getElementById('prevBtn').addEventListener('click', () => {
  viewMonth--;
  if (viewMonth < 1) { viewMonth = 12; viewYear--; }
  selectedDate = null;
  loadMonth();
});

document.getElementById('nextBtn').addEventListener('click', () => {
  viewMonth++;
  if (viewMonth > 12) { viewMonth = 1; viewYear++; }
  selectedDate = null;
  loadMonth();
});

async function loadMonth() {
  const res = await fetch(`/api/calendar?year=${viewYear}&month=${viewMonth}`);
  const data = await res.json();

  monthClaims = {};
  data.claims.forEach((c) => { monthClaims[c.date] = c; });

  renderCalendar();
  renderForm();
}

function dateKey(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function renderCalendar() {
  const label = document.getElementById('monthLabel');
  const grid = document.getElementById('grid');

  label.textContent = new Date(viewYear, viewMonth - 1, 1).toLocaleString(undefined, {
    month: 'long', year: 'numeric',
  });

  grid.innerHTML = '';

  ['S', 'M', 'T', 'W', 'T', 'F', 'S'].forEach((d) => {
    const el = document.createElement('div');
    el.className = 'day-header';
    el.textContent = d;
    grid.appendChild(el);
  });

  const firstDay = new Date(viewYear, viewMonth - 1, 1).getDay();
  const daysInMonth = new Date(viewYear, viewMonth, 0).getDate();

  for (let i = 0; i < firstDay; i++) {
    const el = document.createElement('div');
    el.className = 'cell empty';
    grid.appendChild(el);
  }

  const todayMid = new Date();
  todayMid.setHours(0, 0, 0, 0);

  for (let d = 1; d <= daysInMonth; d++) {
    const key = dateKey(viewYear, viewMonth, d);
    const cellDate = new Date(viewYear, viewMonth - 1, d);
    const isPast = cellDate < todayMid;
    const claim = monthClaims[key];

    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.textContent = d;

    if (claim) {
      cell.classList.add(claim.isMine ? 'mine' : 'taken');
      cell.title = claim.isMine
        ? `Your pledge: $${claim.amount} (${claim.status})`
        : 'Already claimed';
    } else if (isPast) {
      cell.classList.add('past');
    } else {
      if (selectedDate === key) cell.classList.add('selected');
      cell.addEventListener('click', () => {
        selectedDate = key;
        renderCalendar();
        renderForm();
      });
    }

    grid.appendChild(cell);
  }
}

// --- Claim form ---

async function renderForm() {
  const area = document.getElementById('formArea');

  if (!selectedDate) {
    area.innerHTML = `<p style="color:#888;font-size:14px;">Select an open date to pledge an amount.</p>`;
    cardElement = null;
    return;
  }

  const niceDate = new Date(selectedDate + 'T00:00:00').toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  area.innerHTML = `
    <div class="card">
      <strong>${niceDate}</strong>
      <label>Pledge amount (USD)</label>
      <input type="number" id="amountInput" min="1" step="1" placeholder="25" />
      <label>Card details</label>
      <div id="card-element"></div>
      <p id="claimError" class="error hidden"></p>
      <button id="claimBtn">Reserve this date</button>
    </div>
  `;

  // Set up Stripe Elements card field.
  elements = stripe.elements();
  cardElement = elements.create('card');
  cardElement.mount('#card-element');

  document.getElementById('claimBtn').addEventListener('click', submitClaim);
}

async function submitClaim() {
  const amountInput = document.getElementById('amountInput');
  const errEl = document.getElementById('claimError');
  const btn = document.getElementById('claimBtn');
  errEl.classList.add('hidden');

  const amount = Number(amountInput.value);
  if (!amount || amount <= 0) {
    errEl.textContent = 'Enter a valid pledge amount.';
    errEl.classList.remove('hidden');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Processing...';

  try {
    // 1. Get a SetupIntent client secret from the server.
    const setupRes = await fetch('/api/setup-intent', { method: 'POST' });
    const setupData = await setupRes.json();
    if (!setupRes.ok) throw new Error(setupData.error || 'Failed to start payment setup');

    // 2. Confirm the SetupIntent with the card details (this securely
    //    tokenizes the card with Stripe; raw card data never touches our server).
    const { setupIntent, error: confirmError } = await stripe.confirmCardSetup(setupData.clientSecret, {
      payment_method: { card: cardElement },
    });

    if (confirmError) throw new Error(confirmError.message);

    // 3. Send the date, amount, and the resulting payment method id to our server.
    const claimRes = await fetch('/api/claims', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date: selectedDate,
        amount,
        paymentMethodId: setupIntent.payment_method,
      }),
    });
    const claimData = await claimRes.json();
    if (!claimRes.ok) throw new Error(claimData.error || 'Failed to reserve date');

    selectedDate = null;
    await loadMonth();
    await loadMyClaims();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = 'Reserve this date';
  }
}

// --- My claims ---

async function loadMyClaims() {
  const res = await fetch('/api/my-claims');
  const data = await res.json();
  const el = document.getElementById('myClaims');

  if (data.claims.length === 0) {
    el.innerHTML = '<p style="color:#888;font-size:14px;">No pledges yet.</p>';
    return;
  }

  el.innerHTML = data.claims.map((c) => `
    <div class="claim-row">
      <span>${c.date} &mdash; $${c.amount}</span>
      <span class="status-badge status-${c.status}">${c.status}</span>
    </div>
  `).join('');
}

init();
