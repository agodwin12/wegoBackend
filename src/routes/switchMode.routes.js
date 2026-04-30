// src/routes/switchMode.routes.js
//
// These routes are mounted on the auth router in app.js:
//   app.use('/api/auth', authRoutes);      ← existing
//   app.use('/api/auth', switchModeRoutes); ← add this line
//
// OR simply add these two routes directly into auth.routes.js
// at the bottom before module.exports — your call.

'use strict';

const express          = require('express');
const router           = express.Router();
const { authenticate } = require('../middleware/auth.middleware');
const switchModeCtrl   = require('../controllers/switchMode.controller');

// ═══════════════════════════════════════════════════════════════════════
// POST /api/auth/switch-mode
// ─────────────────────────────────────────────────────────────────────
// Switch the caller's active operating mode.
// Issues a fresh token pair with the new active_mode baked in.
//
// Body:   { target_mode: 'PASSENGER' | 'DRIVER' | 'DELIVERY_AGENT' }
//
// Access: Any authenticated user (DRIVER or DELIVERY_AGENT)
//         — validation of who can switch to what is inside the controller.
//
// Returns:
//   {
//     success:       true,
//     data: {
//       previous_mode: string,
//       active_mode:   string,
//       user_type:     string,
//       dashboard:     'passenger' | 'driver' | 'delivery',
//       access_token:  string,
//       refresh_token: string,
//     }
//   }
// ═══════════════════════════════════════════════════════════════════════

router.post('/switch-mode', authenticate, switchModeCtrl.switchMode);

// ═══════════════════════════════════════════════════════════════════════
// GET /api/auth/mode
// ─────────────────────────────────────────────────────────────────────
// Returns the caller's current active_mode and which modes they can
// switch to. Flutter calls this on app resume to confirm mode without
// a full re-login.
//
// Returns:
//   {
//     success: true,
//     data: {
//       user_type:       string,
//       active_mode:     string,
//       dashboard:       string,
//       allowed_targets: string[],
//     }
//   }
// ═══════════════════════════════════════════════════════════════════════

router.get('/mode', authenticate, switchModeCtrl.getCurrentMode);

module.exports = router;