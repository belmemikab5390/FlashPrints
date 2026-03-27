# ⚡ Flash & Prints Photobooth — Electron Kiosk App

Fully unattended photobooth kiosk with GCash QR payment.
No staff needed. You just refill paper and ink.

---

## 📁 Project Structure

```
flashandprints/
├── main.js              ← Electron main process (window + IPC)
├── preload.js           ← Context bridge (safe IPC to renderer)
├── package.json         ← Dependencies
├── .env                 ← Your config (copy from .env.example)
│
├── screens/             ← All 9 kiosk screens (HTML files)
│   ├── fp-bridge.js     ← Shared navigation + session bridge
│   ├── welcome.html     ← Screen 1: Idle / attract
│   ├── packages.html    ← Screen 2: Package selection
│   ├── payment.html     ← Screen 3: GCash QR payment
│   ├── camera.html      ← Screen 4: Camera + countdown
│   ├── preview.html     ← Screen 5: Photo preview + filter
│   ├── printing.html    ← Screen 6: Printing animation
│   ├── receipt.html     ← Screen 7: Official receipt
│   └── done.html        ← Screen 8: Thank you + auto-reset
│
├── server/
│   ├── index.js         ← Express server (GCash webhook)
│   ├── gcash.js         ← GCash merchant API integration
│   ├── printer.js       ← DNP printer bridge
│   └── camera.js        ← DSLR Remote Pro bridge
│
└── assets/
    └── placeholder-photo.jpg
```

---

## 🚀 Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env with your GCash credentials and booth info
```

### 3. Copy your screen HTML files
Copy the 8 screen HTML files you built into the `screens/` folder.
Add this line to the `<head>` of EVERY screen:
```html
<script src="fp-bridge.js"></script>
```

### 4. Update navigation in each screen
Replace `window.location.href` calls with:
```javascript
// Instead of: window.location.href = 'payment.html'
fpNavigate('payment', { package: selectedPkg, filter: selectedFilter });

// Instead of: window.location.href = 'camera.html'
fpNavigate('camera');
```

### 5. Run in development mode
```bash
npm run dev
```

### 6. Build for Windows kiosk
```bash
npm run build-win
```

---

## 💳 GCash Integration

### Apply for merchant account
1. Go to https://developer.globelabs.com.ph
2. Register as a merchant (takes 3-7 business days)
3. Get your `MERCHANT_ID`, `CLIENT_ID`, `CLIENT_SECRET`
4. Add them to your `.env` file

### Set webhook URL in GCash portal
Your kiosk needs a public URL for GCash to send payment confirmations.

**For testing (use ngrok):**
```bash
ngrok http 3000
# Copy the https URL e.g. https://abc123.ngrok.io
# Set webhook to: https://abc123.ngrok.io/gcash/webhook
```

**For production:**
- Your kiosk needs a static public IP or domain
- Set webhook to: `http://YOUR_IP:3000/gcash/webhook`

### Test payment flow (sandbox)
```bash
# Trigger a simulated payment:
curl -X POST http://localhost:3000/gcash/simulate-payment \
  -H "Content-Type: application/json" \
  -d '{"referenceId":"FP-001-1234567890"}'
```

---

## 🖨️ Printer Setup

1. Install **DNP DS620A** or **Mitsubishi CP-D90DW** drivers on Windows
2. Set printer name in `.env`: `PRINTER_NAME=DNP DS620A`
3. Load 2x6 inch ribbon and paper

---

## 📷 Camera Setup

1. Install **Breeze DSLR Remote Pro** on Windows
2. Connect Canon/Nikon DSLR via USB
3. Set CLI path in `.env`: `DSLR_CLI_PATH=C:\Program Files\...`
4. For simulation/testing: set `CAMERA_SIMULATE=true` in `.env`

---

## 🏪 Deploying to a Mall

### Hardware checklist
- [ ] Windows 10/11 PC (i5, 8GB RAM minimum)
- [ ] 1080px touchscreen monitor (portrait orientation)
- [ ] Canon/Nikon DSLR camera + USB cable
- [ ] DNP DS620A dye-sub printer
- [ ] UPS (uninterruptible power supply)
- [ ] Router/SIM card for internet (GCash webhook needs connection)

### Kiosk hardening
- Set Windows to auto-login on boot
- Add app to Windows Startup folder
- Disable Windows updates during mall hours
- Set display to never sleep
- Enable Windows auto-restart on BSOD

### Booth config per location
Change in `.env` for each booth:
```
BOOTH_ID=002
BOOTH_LOCATION=Robinsons Galleria
BOOTH_FLOOR=Level 3
```

---

## 📊 Owner Dashboard

Open `flash-and-prints-dashboard.html` in any browser.
In production: host it on a private server or your laptop.
Access from anywhere via browser while booths run unattended.

---

## 🆘 Troubleshooting

| Problem | Fix |
|---|---|
| GCash QR not generating | Check `.env` credentials, verify merchant account is approved |
| Payment not detected | Check webhook URL in GCash portal, verify ngrok is running |
| Printer not printing | Check `PRINTER_NAME` matches exactly in Windows Devices & Printers |
| Camera not capturing | Verify DSLR is connected USB, DSLR Remote Pro is licensed |
| App crashes on start | Run `npm install` again, check Node.js version ≥ 18 |
| Screen stuck | App auto-restarts after 3 min idle — or reboot via owner dashboard |

---

Built with ❤️ — Flash & Prints Photobooth PH
