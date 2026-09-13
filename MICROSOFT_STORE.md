# Publish Talyfocous to the Microsoft Store

This project is already set up for Microsoft Store distribution:

- **MSIX package** via `electron-builder`
- **StoreBridge.exe** — checks subscription and opens the Store purchase UI
- **Subscription gate** in the app (`visionBooksStore` / overlay on startup)
- **Desktop shortcut** extension in the MSIX manifest

Follow these steps in order.

---

## 1. Prerequisites (one-time)

| Tool | Purpose |
|------|---------|
| [Node.js 18+](https://nodejs.org/) | Build the app |
| [.NET 8 SDK](https://dotnet.microsoft.com/download) | Build StoreBridge |
| [Microsoft Partner Center account](https://partner.microsoft.com/) | Publish to the Store ($19 one-time for individuals) |

On this PC, from the project folder:

```bat
npm install
```

---

## 2. Reserve the app in Partner Center

1. Sign in to [Partner Center](https://partner.microsoft.com/dashboard).
2. **Apps and games** → **New product** → **MSIX or PWA app**.
3. Reserve the name **Talyfocous** (must match `productName` in `package.json`).
4. Open the app → **Product identity** (or **Product management** → **Product identity**).
5. Copy these values — you will need them next:
   - **Publisher** (starts with `CN=...`)
   - **Package identity name** (e.g. `Talyfocous`)
   - **Publisher display name**

---

## 3. Create a subscription add-on

1. In Partner Center, open your Talyfocous app.
2. Go to **Monetization** → **Subscriptions** (or **Add-ons** → create **Subscription**).
3. Create a subscription (monthly/yearly — your choice).
4. After it is saved, copy the **Store ID** of the **subscription add-on** (not the main app ID).

---

## 4. Configure this repository

### Publisher identity

```bat
copy store-publisher.config.example.json store-publisher.config.json
```

Edit `store-publisher.config.json` and paste the **Publisher** from Partner Center exactly:

```json
{
  "publisher": "CN=Your Name, O=Your Company, ...",
  "identityName": "Talyfocous",
  "publisherDisplayName": "Talyfocous",
  "applicationId": "Talyfocous",
  "displayName": "Talyfocous"
}
```

### Subscription Store ID

```bat
copy store.config.example.json store.config.json
```

Edit `store.config.json`:

```json
{
  "subscriptionAddonStoreId": "9XXXXXXXX",
  "devBypass": false
}
```

Use the **subscription add-on Store ID** from step 3.

> **Important:** Rebuild the MSIX after changing `store.config.json` — it is bundled inside the package.

---

## 5. Build the MSIX package

Double-click:

```bat
Build Store Package.bat
```

Or run manually:

```bat
npm run dist:store
```

Output: `dist\Talyfocous-<version>-win-x64.msix` (exact name may vary).

### Troubleshooting build

| Problem | Fix |
|---------|-----|
| StoreBridge build failed | Install .NET 8 SDK; run `dotnet --version` |
| Icon missing | Run `npm run build:icon` |
| Publisher placeholder warning | Set real `CN=...` in `store-publisher.config.json` |
| MSIX rejected on upload | Publisher in config must **exactly** match Partner Center |

---

## 6. Upload to Partner Center

1. Partner Center → your app → **Packages** (or **Submission**).
2. **Upload** the `.msix` from the `dist` folder.
3. Wait for validation (publisher identity must match).

---

## 7. Complete the store listing

Use text in `store-assets/STORE_LISTING.txt` as a starting point.

Required items:

| Item | Notes |
|------|--------|
| Description | Short + full description |
| Screenshots | At least 1; 1366×768 recommended |
| Store logo | 300×300 PNG (`public/logo.png` after icon build) |
| Privacy policy URL | Host `public/privacy.html` on your website, e.g. `https://yoursite.com/privacy.html` |
| Category | Business / Accounting |
| Pricing | Link your subscription add-on |

---

## 8. Submit for certification

1. Associate the uploaded package with the submission.
2. Answer the certification questionnaire (local data, no unexpected network use unless user enables LAN sharing).
3. **Submit to the Store**.

Review usually takes from a few hours to a few business days.

---

## 9. Test before you submit

### Test subscription locally (development)

In `store.config.json` set `"devBypass": true` and use the normal desktop build — the subscription overlay is skipped.

### Test Store build sideload (advanced)

After Partner Center creates your app, you can sideload the MSIX on a test PC if the publisher certificate matches. Most developers rely on Partner Center **Flight** (beta) distribution for testing.

---

## Environment variables (optional, CI/CD)

```bat
set VISIONBOOKS_STORE_PUBLISHER=CN=...
set VISIONBOOKS_SUBSCRIPTION_STORE_ID=9XXXXXXXX
npm run dist:store
```

---

## Files reference

| File | Purpose |
|------|---------|
| `store-publisher.config.json` | Partner Center publisher identity (not committed) |
| `store.config.json` | Subscription add-on Store ID (bundled in MSIX) |
| `electron-builder.store.cjs` | MSIX build config |
| `store-bridge/StoreBridge.exe` | Windows Store license API bridge |
| `Build Store Package.bat` | One-click build script |
| `public/privacy.html` | Privacy policy page for listing URL |

---

## What you must do outside this repo

These cannot be automated from code:

1. Create and verify **Partner Center** seller account  
2. Reserve **Talyfocous** and copy **Publisher** / identity  
3. Create **subscription** add-on and copy **Store ID**  
4. Host **privacy policy** at a public URL  
5. Prepare **screenshots** and store description  
6. **Upload MSIX** and submit for certification  

After certification, users install from the Microsoft Store and subscribe through your configured add-on.
