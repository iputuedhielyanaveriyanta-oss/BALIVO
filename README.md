# BALIVO — Bali's Online Marketplace

Versi baru ini dibuat terpisah dari WBF.

## File
- `index.html` — customer storefront
- `admin.html` — BALIVO Admin
- `balivo-manifest.webmanifest` — PWA customer
- `balivo-admin-manifest.webmanifest` — PWA admin
- `balivo-admin-sw.js` — cache/service worker

## Konsep
Customer: katalog → stok → cart → checkout → pembayaran → order.

Admin: produk → supplier → modal → markup → stok → order → profit → dropship import.

## Catatan
Versi ini adalah frontend/MVP yang bersih. Pembayaran otomatis seperti Shopee membutuhkan payment gateway merchant dan backend/API yang aman. Import supplier saat ini menerima JSON/CSV; koneksi API supplier/Shopee dilakukan pada tahap integrasi berikutnya.
