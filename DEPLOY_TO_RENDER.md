# Deploy License Server to Render.com

## Quick Start (5 minutes)

### 1. Create GitHub Repository for Backend
```powershell
cd "d:\New folder\PsyStudio WIN\Psypower-main - Copy - Copy\backend"
git init
git add .
git commit -m "Initial commit - License server"
```

Then push to GitHub:
- Go to https://github.com/new
- Create a new repository (e.g., `psystudio-license-server`)
- Copy the commands and run them:
```powershell
git remote add origin https://github.com/YOUR-USERNAME/psystudio-license-server.git
git branch -M main
git push -u origin main
```

### 2. Deploy to Render

1. **Sign up/Login to Render**
   - Go to https://render.com
   - Sign up with GitHub (free)

2. **Create New Web Service**
   - Click "New +" → "Web Service"
   - Connect your GitHub repository: `psystudio-license-server`
   - Click "Connect"

3. **Configure Service**
   - **Name:** `psystudio-license-server`
   - **Region:** Choose closest to your users
   - **Branch:** `main`
   - **Root Directory:** Leave empty (or `.` if needed)
   - **Environment:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free

4. **Add Persistent Disk** (IMPORTANT!)
   - Scroll down to "Disk"
   - Click "Add Disk"
   - **Name:** `license-data`
   - **Mount Path:** `/app/data`
   - **Size:** 1 GB (free tier)
   - Click "Save"

5. **Environment Variables** (Optional)
   - Click "Advanced" → "Add Environment Variable"
   - Add `ADMIN_KEY` = `your-secure-admin-key-here`
   - Add `NODE_ENV` = `production`

6. **Deploy**
   - Click "Create Web Service"
   - Wait 2-3 minutes for deployment
   - Your URL will be: `https://psystudio-license-server.onrender.com`

### 3. Test Your Deployment

Open your browser and go to:
```
https://psystudio-license-server.onrender.com/health
```

You should see:
```json
{
  "status": "ok",
  "timestamp": "2024-10-26T...",
  "environment": "production"
}
```

### 4. Update Frontend API URL

In your `security-updated.js`, replace `http://localhost:3001` with your Render URL:

```javascript
// Find these lines:
const response = await fetch('http://localhost:3001/api/activate-license', {
const response = await fetch('http://localhost:3001/api/login', {

// Replace with:
const API_URL = 'https://psystudio-license-server.onrender.com';
const response = await fetch(`${API_URL}/api/activate-license`, {
const response = await fetch(`${API_URL}/api/login`, {
```

## Alternative: One-Click Deploy

You can also use Render's one-click deploy by adding a `render.yaml` file to your repository root. The file is already created in the `backend` folder!

1. Push `render.yaml` to your GitHub repo
2. Go to https://dashboard.render.com
3. Click "Blueprint" → Connect your repo
4. Render will auto-configure everything!

## Troubleshooting

### "Service Unavailable" Error
- Check Render logs: Dashboard → Your Service → Logs
- Ensure disk is mounted correctly
- Verify `npm install` completed successfully

### "Database Error" Messages
- Check disk mount path: `/app/data`
- Verify disk is attached to service
- Check logs for file permission errors

### Cold Starts (Free Plan)
- Free services sleep after 15 minutes of inactivity
- First request after sleep takes 30-60 seconds
- Upgrade to paid plan ($7/month) to prevent sleep

### CORS Errors
- Backend already configured with `cors: '*'`
- If issues persist, add your domain specifically

## Testing API Endpoints

### Test Activation
```powershell
curl -X POST https://psystudio-license-server.onrender.com/api/activate-license `
  -H "Content-Type: application/json" `
  -d '{\"code\":\"PSYSTUDIO-2024-FULL\",\"username\":\"testuser\",\"password\":\"testpass123\",\"hardwareID\":\"test-hw-id\"}'
```

### Test Login
```powershell
curl -X POST https://psystudio-license-server.onrender.com/api/login `
  -H "Content-Type: application/json" `
  -d '{\"username\":\"testuser\",\"password\":\"testpass123\",\"hardwareID\":\"test-hw-id\"}'
```

### View Activations (Admin)
```powershell
curl https://psystudio-license-server.onrender.com/api/admin/activations `
  -H "x-admin-key: PSYSTUDIO-ADMIN-2024"
```

## Database Backup

Your data is stored on the persistent disk. To backup:

1. **Access via Render Shell:**
   - Dashboard → Your Service → Shell
   - Run: `cat /app/data/users-database.json`
   - Copy the output

2. **Automated Backup (Recommended):**
   - Add a backup endpoint to your API
   - Call it periodically to save to external storage (S3, Dropbox, etc.)

## Upgrading to Paid Plan

Benefits of upgrading ($7/month):
- ✅ No cold starts (always running)
- ✅ More resources (faster API responses)
- ✅ Custom domains
- ✅ More disk space
- ✅ Priority support

## Security Recommendations

1. **Change Admin Key:**
   - In Render dashboard: Environment Variables
   - Set `ADMIN_KEY` to a strong random string
   - Update your admin scripts

2. **Add Rate Limiting:**
   - Install `express-rate-limit`
   - Prevent brute force attacks

3. **Enable HTTPS Only:**
   - Render automatically provides HTTPS
   - Force HTTPS in your Electron app

4. **Monitor Logs:**
   - Check logs regularly for suspicious activity
   - Set up email alerts in Render dashboard

## Cost Estimate

- **Free Plan:** $0/month (with limitations)
- **Starter Plan:** $7/month (recommended)
- **Data Transfer:** Usually included (1TB+)
- **Disk Storage:** 1GB included, $0.25/GB extra

## Support

If you have issues:
1. Check Render status: https://status.render.com
2. View logs in Render dashboard
3. Check Render docs: https://render.com/docs
4. Community forum: https://community.render.com
