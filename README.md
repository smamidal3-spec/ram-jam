# Ram Jam

Ram Jam is a real-time synchronized YouTube audio player that lets two users listen to the same music simultaneously. 

## One-Command Launcher (Windows)
From this folder, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\launch-ram-jam.ps1
```

This starts both `node server.js` and a Cloudflare quick tunnel, then prints an `Invite URL` you can send to your friend on another machine.

## Deployment Instructions

### Option 1: Render.com (Recommended for WebSockets)
1. Go to [Render.com](https://render.com/) and create a free account.
2. Push this folder to a new **GitHub Repository**.
3. In Render, create a new **Web Service**.
4. Connect your GitHub repository.
5. Set the Build Command to: `npm install`
6. Set the Start Command to: `npm start`
7. Render will provide you a permanent `https://...onrender.com` URL that natively supports WebSockets.

### Option 2: Railway.app
1. Go to [Railway.app](https://railway.app/).
2. Push this folder to a GitHub repository or use the Railway CLI (`railway up`).
3. Railway will automatically detect the `package.json` and deploy it instantly.
