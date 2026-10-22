# VANTA Team Desk

VANTA Team Desk is a Windows desktop team workspace for VALORANT squads. The app starts with an animated opening, then account sign-in, then a create/join-team step. Accounts and team collaboration use Supabase; sign-in, shared availability, chats, roster changes, and coach posts need an internet connection.

[Download the latest Windows installer](https://github.com/beg111eryt/Vanta-team-desk/releases/latest/download/VANTA-Team-Desk-Setup.exe) · [View all releases](https://github.com/beg111eryt/Vanta-team-desk/releases)

## Team features

- **Account access:** Email/password, Google, and Discord through Supabase Auth. Riot sign-in is not included until Riot OAuth approval and credentials are available.
- **Create or join a team:** Set the team name, tag, region, description, and optional picture. Team creators receive a 32-character invite code; members enter it and wait for an admin to approve them.
- **Roster and admins:** Assign approved members as Main roster, Main substitute, Substitute, Tryout, or Coach. Admin access is a separate permission and can be granted to additional members. Teams always keep an admin.
- **Shared hourly availability:** Every approved member marks their own weekly schedule. The team sees the overlap in the team's time zone, with realtime updates.
- **Coach hub:** Coaches and admins can post feedback. Main roster, main substitutes, and admins can share VOD links.
- **Chats:** English global chat for signed-in users; team chat excludes tryouts; main chat is for main roster and coaches; admins can create custom chats for selected roles and members and can access every chat in their team.
- **Scrim tools:** Track opponent, map, timer, round score, side, practice focus, and notes; keep match history and playbook entries. These records are stored locally per team on each computer, not shared through the online backend. The app does not read game data or collect player combat stats.
- **Appearance:** Choose theme, font, and text size.

VOD posts store links (not uploaded video files). The global channel is intended for English conversation; language is a community rule rather than automatic translation or language detection.

## Free setup and tutorial

You can set up and share the app without buying a server or custom domain by using Supabase Free and GitHub's free repository, Pages, and Releases features. Free-plan quotas and terms can change. Supabase Free projects may pause after a week without activity and have limited database, file storage, and network quotas; check the current [Supabase pricing](https://supabase.com/pricing) before inviting a large group. Keep the project on Free and do not enable paid add-ons if you need to avoid charges.

### 1. Create the Supabase project

1. Create a Supabase account and a new project. Select the **Free** plan and a region near most teammates.
2. Save the database password privately. Do not put it in the desktop app, GitHub, or the download website.
3. Open the project's **SQL Editor**, open [`supabase/schema.sql`](./supabase/schema.sql) from this repository, paste its contents, and run it once. This creates the tables, row-level security policies, team functions, team-picture bucket, and realtime entries required by the app.
4. In **Authentication → URL Configuration → Redirect URLs**, add exactly `vantateamdesk://auth/callback`.

### 2. Set up a free sign-in provider

Google or Discord OAuth is recommended for a small team because Supabase's built-in email sender is limited. The app includes email/password controls, but Supabase's default SMTP is not a general-purpose mail service: confirmation and reset emails may only be delivered to authorized project-team addresses and are rate-limited. Do not assume email/password will work for every teammate unless you configure a custom SMTP provider. Provider free tiers and quotas can change.

#### Discord OAuth setup

Set up Discord through Supabase Auth; do not add Discord credentials to the desktop app or an `.env` file.

1. **Get the Supabase callback URL.** In your Supabase project, open **Authentication → Sign In / Providers → Discord**. Copy the callback URL shown in the Discord provider settings. It looks like:

   `https://<your-project-ref>.supabase.co/auth/v1/callback`

2. **Create a Discord application.** Open the [Discord Developer Portal](https://discord.com/developers/applications), choose **New Application**, give it a name, and create it.
3. **Register Supabase's callback in Discord.** In the new application, open **OAuth2**. Under **Redirects**, add the exact callback URL copied from Supabase, then save the changes. This is the provider-to-Supabase URL; do not put `vantateamdesk://auth/callback` here.
4. **Copy the Discord credentials.** On the Discord application's OAuth2 page, copy its **Client ID** and generate/copy its **Client Secret**. Keep the secret private.
5. **Enable Discord in Supabase.** Return to **Supabase → Authentication → Sign In / Providers → Discord**, turn on the provider, paste the Discord Client ID and Client Secret into the matching fields, and save.
6. **Allow the desktop app callback in Supabase.** Open **Supabase → Authentication → URL Configuration → Redirect URLs** and add this exact URL:

   `vantateamdesk://auth/callback`

   Supabase uses this second URL to return the user to the desktop app after Discord authentication. It is different from the HTTPS callback registered in Discord.

7. **Test sign-in.** Install and open VANTA Team Desk, connect it to your Supabase project with the Project URL and public anon/publishable key, then select **Discord**. The app opens the system browser; after authorization, the browser returns to the app. The packaged Windows installer registers the `vantateamdesk://` protocol. For local development, run `npm start` to register the development app's protocol handler.
8. **If Discord reports a redirect error**, check that the HTTPS URL in the Discord Developer Portal exactly matches the callback shown in the Supabase Discord provider settings, and that `vantateamdesk://auth/callback` is in Supabase's allowed Redirect URLs.

You do not need to create a Discord bot or request bot permissions for sign-in. The app uses Supabase's authorization-code/PKCE flow and opens the OAuth URL in the system browser. The Discord Client Secret belongs **only** in Supabase's Discord provider settings. This Electron app does not load `.env` files: `server/.env` is leftover configuration for the removed Render/Node server and is not used or packaged. Do not put Discord credentials, database passwords, or service-role keys in that file, in the desktop app, or in GitHub. In the app's connection form, enter only the Supabase Project URL and public anon/publishable key.

#### Troubleshooting: `Unsupported provider: provider is not enabled`

This 400 response comes from Supabase Auth before Discord sign-in begins. The app requests the supported `discord` provider; this message usually means Discord is not enabled on the Supabase project that the app is currently contacting.

1. In VANTA Team Desk, open **Connect to your team service** on the sign-in screen and check the displayed **Connected Supabase project** host.
2. In the Supabase Dashboard, select the project with that same project reference. Under **Authentication → Sign In / Providers → Discord**, make sure Discord is enabled, the Discord Client ID and Client Secret are filled in, and the settings have been saved.
3. If the host is for a different project, replace the app's Supabase Project URL and public anon/publishable key with values from the project where you enabled Discord, then save the connection. The URL and key must belong to the same project.
4. Retry Discord sign-in. Changing these provider settings in Supabase does not require rebuilding the app.

The app saves its Supabase connection locally; it does not read `server/.env`. Enabling Discord in one Supabase project will not enable it in another project.

For Google, create an OAuth client in Google Cloud Console and configure it using the corresponding callback URL shown in Supabase. In Google OAuth consent settings, add teammates as test users while the app is in testing mode.

### 3. Connect the desktop app

1. Download the Windows installer from the GitHub Releases page and install it.
2. On the sign-in screen, enter the Supabase **Project URL** and **public anon/publishable key**. Find both in the Supabase project's API settings.
3. Never enter a database password, `service_role` key, or other secret key into the app or publish one in GitHub. The public client key is intended for desktop/browser clients; row-level security protects data access.
4. Sign in with the provider you enabled. The first account creates a team and receives a 32-character invite code. Teammates install the same app, sign in, submit that code, and wait for a team admin to approve them.
5. The team creator's time zone becomes the shared availability time zone. Admins can approve members, set roster roles, and create replacement invite codes.

### 4. Publish the download page and installer for free

1. From the repository root (the folder containing `.github` and `valorant-team-desk`), review the changes with `git status --short`. Stage the app and deployment workflows with `git add .github valorant-team-desk`, then inspect `git diff --cached --stat` and `git status --short` before committing and pushing to `main`. Do not use `git add .` blindly: leave `.vscode/`, `hs_err_pid*.log`, and `replay_pid*.log` out of the upload. Never upload `.env` files, database passwords, service-role keys, or other secrets.
2. In the repository's **Settings → Pages**, choose **GitHub Actions** as the deployment source. The Pages workflow publishes `valorant-team-desk/site`; its URL appears in the workflow run.
3. Check the GitHub URLs in [`site/index.html`](./site/index.html) point to your own repository.
4. Push a version tag such as `v2.1.0`. The release workflow builds the Windows installer and attaches it to a GitHub Release. Share the Pages link to the download page, or share the Release link directly. A custom domain is optional and not required.

GitHub and Supabase limits still apply. The installer is unsigned, so Windows SmartScreen may warn teammates. Only install it if you trust the source.

## Build the Windows installer

On Windows, install Node.js 20 or newer, open PowerShell in this folder, then run:

```powershell
npm ci
npm start
```

Create the installer with:

```powershell
npm run dist
```

The output is `release\VANTA-Team-Desk-Setup.exe`. The installer is unsigned; Windows SmartScreen may warn users. Only install copies from a source you trust.

## Publish the download website and app

The download page is in [`site/index.html`](./site/index.html). To publish it:

1. Push the repository to GitHub.
2. In **Settings → Pages**, set the build/deployment source to **GitHub Actions**.
3. Push a change to `site/` on `main`, or manually run the **Deploy app download site** workflow. GitHub shows the published URL in the workflow run.

To publish a new installer, push a version tag such as `v2.1.0`. The **Build and publish Windows installer** workflow builds the Windows installer and attaches it to a GitHub Release. The download page links to the latest release. Confirm the repository URL in `site/index.html` matches the GitHub repository before publishing.

## Data and privacy

Roster, approval status, team profile, availability, chats, coach feedback, and VOD links are stored in Supabase and shared according to the team role policies. Match logs, live scrims, practice notes, playbook, and appearance are stored on each computer in a team-specific local workspace. Use app export/import if you want to exchange those local records manually.

Do not share a team code publicly. It is a bearer invite: anyone with the active code can request membership, but an admin must approve them. Global chat is visible to all signed-in VANTA users. Avoid posting personal information or private team details there.
