require('dotenv').config();
const express = require('express');
const cookieSession = require('cookie-session');
const path = require('path');

const authRoutes = require('./routes/auth');
const calendarRoutes = require('./routes/calendar');

const app = express();

app.use(express.json());
app.use(
  cookieSession({
    name: 'session',
    keys: [process.env.SESSION_SECRET || 'dev-secret-change-me'],
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  })
);

app.use(express.static(path.join(__dirname, 'public')));

app.use('/auth', authRoutes);
app.use('/api', calendarRoutes);

// Expose Stripe publishable key to the front end.
app.get('/api/config', (req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
