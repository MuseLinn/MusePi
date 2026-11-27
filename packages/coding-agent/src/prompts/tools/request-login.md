Ask the user to save a website sign-in you need, so you can sign in without ever seeing the password.

Use this when a task needs an account on a site the browser tool is on and no saved login covers it. The tool takes a NAME, the SITE and a one-line PURPOSE.

- A card appears in the conversation with a small form: the site, a username, the password, and an optional 2FA setup key. The user fills it; you never see any of it.
- When a login for that site and this workspace already exists, the tool returns immediately without a card.
- After saving, sign in with the browser tool: `action: "fill_login"` and the login NAME. The browser types the username, the password and a current one-time code into the page itself. The values never reach you, a tool result, or a transcript.
- Never ask the user to paste a password or a one-time code into chat, and never try to read one from the page: the page will show it to the browser, not to you.
- If the user declines, continue without signing in or ask what they prefer. Do not retry the same request.

NAMES use A-Z, 0-9 and _ and start with a letter. Pick one that says what the account is for, such as ACME_PORTAL.
