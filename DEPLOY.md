# Deployment Guide for SafeTrack Vault System

This application is a **Full-Stack Node.js Application** built with React, Vite, and Express. It uses **IndexedDB (via Dexie.js)** for local data storage on the client, and an Express server to handle backend tasks like sending emails via SMTP.

## ⚠️ Critical Data Warning

**IMPORTANT:** Because this application uses browser-local storage (IndexedDB) for its database:
1.  **Data is stored only on the device/browser where it is entered.**
2.  **Clearing browser cache/data will delete all records.**
3.  **Data is not synced between devices.** (e.g., entering data on a laptop won't show up on a phone).

**Recommendation:** For production use with critical financial data, ensure you regularly use the **"Export Database"** feature in the Settings menu to backup your data to a secure location.

---

## 1. Building for Production

To create a production-ready build of the application, run the following command in your terminal:

```bash
npm run build
```

This will compile the React frontend into a `dist` folder.

## 2. Hosting Options

Because this application includes a Node.js backend (for the email sending functionality), it **cannot** be hosted on purely static hosting providers like GitHub Pages. You must use a hosting provider that supports Node.js servers.

### Option A: Render / Heroku / DigitalOcean App Platform (Recommended)
1. Connect your GitHub repository to the platform.
2. Set the Build Command to: `npm install && npm run build`
3. Set the Start Command to: `npm start`
4. The platform will automatically install dependencies, build the frontend, and start the Express server.

### Option B: VPS or Dedicated Server (Ubuntu/Debian)
1. Clone the repository to your server.
2. Install Node.js (v18+ recommended).
3. We have included an automated deployment script (`deploy.sh`) to make this process easier. Make the script executable and run it:
   ```bash
   chmod +x deploy.sh
   ./deploy.sh
   ```
   *This script will automatically install dependencies, build the frontend, install `pm2` (if missing), and start/restart the server in the background.*
4. Set up a reverse proxy (like Nginx) to route traffic from port 80/443 to your app's port (default is 3000).

**Nginx Reverse Proxy Example:**
```nginx
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## 3. Environment Variables

If you are using any API keys, ensure they are set in your hosting provider's environment variables settings or in a `.env` file on your server.

- `VITE_GEMINI_API_KEY`: Your Google Gemini API Key (if applicable).

---

## 4. Future Considerations (Cloud Sync)

If you need multi-user access or cloud backup, the application would need to be updated to sync with a backend database (like Firebase, Supabase, or a custom SQL server). Currently, all database records remain on the local client device.
