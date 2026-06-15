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

  for (let d = 1; d <= daysInMonth; d++) {
    const key = dateKey(viewYear, viewMonth, d);
    const claim = monthClaims[key];

    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.innerHTML = `<span class="day-num">${d}</span><span class="day-amt">$${d}</span>`;

    if (claim) {
      cell.classList.add(claim.isMine ? 'mine' : 'taken');
      cell.title = claim.isMine
        ? `Your donation: $${claim.amount}`
        : 'Already claimed';
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
    area.innerHTML = `<p style="color:#888;font-size:14px;">Select a date to donate that amount (e.g. the 15th = $15).</p>`;
    cardElement = null;
    return;
  }

  const day = Number(selectedDate.split('-')[2]);
  const niceDate = new Date(selectedDate + 'T00:00:00').toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  area.innerHTML = `
    <div class="card">
      <strong>${niceDate}</strong>
      <p style="margin: 6px 0 12px;">Donation amount: <strong>$${day}</strong></p>
      <label>Card details</label>
      <div id="card-element"></div>
      <p id="claimError" class="error hidden"></p>
      <button id="claimBtn">Donate $${day} and claim this date</button>
    </div>
  `;

  // Set up Stripe Elements card field.
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
    // 1. Create a PaymentMethod from the card details (tokenizes the card
    //    with Stripe; raw card data never touches our server).
    const { paymentMethod, error: pmError } = await stripe.createPaymentMethod({
      type: 'card',
      card: cardElement,
    });

    if (pmError) throw new Error(pmError.message);

    // 2. Send the date and payment method id to our server, which charges
    //    the card immediately for an amount equal to the day-of-month.
    const claimRes = await fetch('/api/claims', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date: selectedDate,
        paymentMethodId: paymentMethod.id,
      }),
    });
    const claimData = await claimRes.json();

    if (!claimRes.ok) {
      // If Stripe requires extra authentication (3D Secure), handle it here.
      if (claimData.requiresAction && claimData.clientSecret) {
        const { error: confirmError } = await stripe.confirmCardPayment(claimData.clientSecret);
        if (confirmError) throw new Error(confirmError.message);
        // Retry the claim now that the payment is confirmed.
        const retryRes = await fetch('/api/claims', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date: selectedDate, paymentMethodId: paymentMethod.id }),
        });
        const retryData = await retryRes.json();
        if (!retryRes.ok) throw new Error(retryData.error || 'Failed to complete donation');
      } else {
        throw new Error(claimData.error || 'Failed to complete donation');
      }
    }

    selectedDate = null;
    await loadMonth();
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

  if (data.claims.length === 0) {
    el.innerHTML = '<p style="color:#888;font-size:14px;">No pledges yet.</p>';
    return;
  }

  el.innerHTML = data.claims.map((c) => `
    <div class="claim-row">
      <span>${c.date} &mdash; $${c.amount}</span>
      <span class="status-badge status-CHARGED">Donated</span>
    </div>
  `).join('');
}

init();
