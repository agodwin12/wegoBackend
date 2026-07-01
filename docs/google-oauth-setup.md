# Google OAuth — Setup & How It Works (WeGo)

WeGo supports "Continue with Google" for **passengers** and **drivers** (not admins).
The backend verifies a Google **ID token** server-side and find-or-creates the
account. This doc is the runbook to make it live + an explanation of the flow.

## 1. The contract (already implemented)

**Single endpoint:** `POST /api/auth/google`

| Field        | Required? | Meaning |
|--------------|-----------|---------|
| `id_token`   | yes       | The Google ID token from the mobile Google Sign-In SDK |
| `user_type`  | no        | Omit to **log in** (existing account's role is used). Send `PASSENGER`/`DRIVER` to **sign up** a new account in that role. |

Responses (verified live):
- missing `id_token` → `400 GOOGLE_ID_TOKEN_REQUIRED`
- invalid token → `401 INVALID_GOOGLE_TOKEN`
- non passenger/driver role → `403 GOOGLE_SIGNUP_NOT_ALLOWED_FOR_USER_TYPE`
- login with no linked account → `404 GOOGLE_ACCOUNT_NOT_FOUND` (UI prompts signup)
- success → `200` with `{ access_token, refresh_token, user, is_new_account,
  requires_phone_verification, requires_driver_profile, requires_admin_approval }`

## 2. Google Cloud Console

Create an OAuth consent screen, then credentials:
1. **Web application** client ID → this is the **audience** the backend verifies.
   Put it in the backend env: `GOOGLE_CLIENT_ID=<web-client-id>.apps.googleusercontent.com`.
2. **Android** client ID — package name `com.<your.app>` + the SHA-1/SHA-256 of
   **every** signing key (debug + Play upload + Play app-signing). Lives in
   `android/app/google-services.json`.
3. **iOS** client ID — bundle id. Lives in `ios/Runner/Info.plist` (reversed client id URL scheme).

> The mobile app must request an ID token whose **audience is the *Web* client ID**
> (the `serverClientId` pattern) so the backend can verify it.

## 3. Backend config
- Set the real `GOOGLE_CLIENT_ID` in `.env.development` / `.env.production`
  (currently a placeholder `your_google_web_client_id…`).
- **Schema:** the Google columns (`google_id`, `auth_provider`,
  `last_login_provider`, `google_avatar_url`) + nullable `password_hash` are added
  by `migrations/20260701000000-add-google-auth-to-accounts.js`. Localhost already
  has them. For a fresh/prod DB run:
  ```bash
  node scripts/run-migration.js migrations/20260701000000-add-google-auth-to-accounts.js up
  ```
  (The migration is idempotent.)

## 4. Mobile config
- In `lib/authentication service/google_auth_service.dart`, set `_serverClientId`
  to the **Web** client ID (replace `YOUR_WEB_CLIENT_ID...`).
- Drop the real `google-services.json` into `android/app/` and configure iOS.

## 5. How it works — passenger
1. Tap **Continue with Google** (login) → `loginWithGoogle()` → `POST /auth/google { id_token }`.
   - Returning passenger → `200` + tokens → `_handleAuthSuccess` stores the session,
     connects the socket, routes to the passenger home.
   - No account yet → `404 GOOGLE_ACCOUNT_NOT_FOUND` → UI shows "sign up".
2. **Sign up as passenger** → `registerPassengerWithGoogle()` → `POST /auth/google { id_token, user_type: PASSENGER }`
   → account created (no password, email pre-verified) → logged straight in.
3. `requires_phone_verification` is returned `true` (Google has no phone). Optionally
   route to the OTP screen (`/auth/otp/send` + `/auth/otp/verify`) to capture a phone.

## 6. How it works — driver (two-step, the clean path)
1. **Sign up as driver with Google** → `registerDriverWithGoogle()` →
   `POST /auth/google { id_token, user_type: DRIVER }` → base driver account created
   + tokens, with `requires_driver_profile: true` and `requires_admin_approval: true`.
   `_handleAuthSuccess` logs them in and routes to the driver app.
2. The driver completes their **vehicle + documents** in-app (authenticated):
   - `POST /api/profile/driver/vehicle`
   - `POST /api/profile/driver/documents` (one per document)
3. An admin approves the driver (`PATCH /api/backoffice/drivers/:id/approve`).
   Until approved, `requireActiveDriver` blocks `go online`, so they can't receive
   rides — exactly as with a password signup.

This deliberately avoids forcing Google into the password/OTP driver-signup flow.
The driver's password is never set; they always return via Google.

## 7. Account linking rules (backend, already enforced)
- Find-or-create by `google_id` **or** `email`.
- A `LOCAL` (password) account that signs in with the same Google email is upgraded
  to `LOCAL_GOOGLE` (both methods work).
- Signing **up** with a role that conflicts with an existing account →
  `409 ACCOUNT_EXISTS_WITH_DIFFERENT_ROLE`. (Logging in never conflicts.)
- Suspended/deleted accounts are rejected (`403`).
