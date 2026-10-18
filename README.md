# VANTA Team Desk

A shared scrim journal and tactical playbook for VALORANT teams. Teams have accounts, a captain-approved roster, shared match logs, and a shared playbook. The app does not connect to VALORANT, read game memory, or automate inputs.

## Run locally

Requirements: Node.js 20 or newer and PostgreSQL.

1. Create a PostgreSQL database for the app.
2. In `server`, run `Copy-Item .env.example .env`, then edit `.env`.
3. Set `DATABASE_URL` to the database connection string.
4. Generate a random secret with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` and set it as `SESSION_SECRET`.
5. Install and start the API/web app:

```powershell
cd valorant-team-desk/server
npm install
npm start
```

Open <http://localhost:3002>. The Node server serves both the web interface and API from the same origin. It creates its tables on startup.

## Accounts and teams

- Create an account with a display name, email, and password of at least 10 characters.
- After signing in, create a team as captain or enter a captain's team code to request membership.
- Captains find the join code, roster, and pending requests under **Team**.
- A captain must approve each request before that player can view the team's workspace.
- Approved members see the same shared match log and playbook. The Team panel shows the approved roster.
- When logging a match, select the players who played from the approved roster.
- Team workspace changes sync to PostgreSQL. The browser also keeps a local backup.

## Match formats

Choose Single map, BO1, BO2, BO3, or BO5. Single-map entries use round scores; best-of entries use maps won. BO2 supports a 1–1 draw.

## Deployment

Deploy the `server` app with a PostgreSQL database and serve it over HTTPS. Set `DATABASE_URL`, a unique random `SESSION_SECRET`, `NODE_ENV=production`, and the hosting platform's `PORT`. Keep the web interface and `/api` on the same origin so the secure session cookie works. Back up the PostgreSQL database; local browser backups are not a substitute for a server backup.

For Render, push this project directory as a GitHub repository and create a Blueprint from `render.yaml`. It creates the web service and PostgreSQL database; the database plan can incur charges. The service URL hosts a small download page and is the address desktop users enter. It is not a team name or team code.

Push a version tag such as `v1.0.0` to run the GitHub Actions release workflow; it builds and publishes `VANTA-Team-Desk-Setup.exe`. Then set the Render service's `DESKTOP_DOWNLOAD_URL` environment variable to `https://github.com/OWNER/REPOSITORY/releases/latest/download/VANTA-Team-Desk-Setup.exe`. The website's Download button redirects to that asset. If the setting is empty, the page explains that the installer has not been published.

Do not commit `.env` or expose `SESSION_SECRET` or database credentials. Account email addresses are used for sign-in; team membership is verified by captain approval rather than email confirmation.

## Windows desktop installer

The desktop client is an Electron app packaged as a Windows NSIS installer. It includes the same team desk interface and connects to the hosted API; it does not include a database or host team data.

1. Install Node.js 20 or newer on a Windows build machine.
2. From this project directory, run `npm install`.
3. Run `npm run dist`. The installer is written to `release/VANTA-Team-Desk-Setup.exe`.
4. Install and launch it, then enter the hosted HTTPS service address supplied by the captain. The address is saved on that device. Local HTTP addresses are accepted only for localhost development.

Team sharing requires the API and PostgreSQL database to be deployed and reachable over HTTPS. After connecting the installer to that service, create an account, then choose **Create team as captain**. Teammates install the app, connect to the same service, create accounts, and submit the captain's join code for approval.
The installer can be built and used without a preconfigured server, but accounts and shared team data are unavailable until a server address is configured.
The generated installer is unsigned; Windows SmartScreen may require **More info → Run anyway**. A trusted code-signing certificate is needed to remove that warning.

## Sharing and privacy

The captain shares the join code with prospective players. A code only submits a join request; it does not grant access on its own. Approved members can see team match notes, selected players, and playbook entries. Share codes only with people who should be allowed to request access.

The export/import controls are for workspace backup and migration. Imported match player selections are kept only for players in the current team's roster.

## What the app tracks

- Match opponent, map or maps, format, result, scores, date, starting side, practice focus, takeaway, and selected team players.
- Playbook map, side, round type, agent notes, and team plan.
- Team record summaries, focus-area counts, and recent takeaways.

Focus summaries are descriptive, not proof that any practice focus caused a result. Match details and agent assignments are entered manually; there is no live game or Riot API integration.
