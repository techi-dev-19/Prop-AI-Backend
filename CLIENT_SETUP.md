# Single client account — Agarwaal Homes

Public self-service signup is disabled in `src/routes/authRoutes.js`. Create the client account using the seed utility.

```bash
# Set these in the backend environment first:
CLIENT_NAME="Agarwaal Homes"
CLIENT_EMAIL="client@your-company-domain.com"
CLIENT_PASSWORD="a-unique-strong-password-at-least-12-chars"

npm run seed:client
```

The seed utility creates a `broker` account only if that email does not already exist. It does not change the password or role of an existing user. `CLIENT_EMAIL` is also an authentication allowlist: other accounts remaining in an old database are blocked from login, refresh and authenticated API requests. For the cleanest one-client install, use a fresh production database or archive unrelated accounts after backing up. Rotate credentials securely if a password is forgotten; use the Forgot Password flow once Brevo is configured.

Do not expose `CLIENT_PASSWORD`, MongoDB URI, JWT secrets, Brevo API key or Meta access token to the frontend. Never put secrets into `VITE_*` environment variables.
