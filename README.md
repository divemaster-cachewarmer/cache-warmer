# Divemaster Cache Warmer

Cache warmer untuk `https://divemasterlembongan.com` setelah migrasi ke Next.js.

## Menjalankan

```powershell
npm ci
npm run start
```

Konfigurasi lokal tetap dibaca dari `.env`:

- `APPS_SCRIPT_URL`: URL deployment Apps Script `/exec` untuk logging Sheets. Jika kosong, logging hanya ke terminal.
- `APPS_SCRIPT_TIMEOUT_MS`: batas waktu menunggu respons Apps Script dalam milidetik;
  default `120000` (120 detik). Misalnya `180000` untuk 3 menit. Nilainya harus
  bilangan bulat positif. Pengaturan ini juga berlaku di GitHub Actions jika
  ditambahkan sebagai environment variable; tanpa pengaturan tambahan memakai default.
- `BRD_PROXY_ID`: URL proxy HTTPS opsional untuk mengambil sitemap dan menghangatkan halaman.
- `CLOUDFLARE_ZONE_ID` dan `CLOUDFLARE_API_TOKEN`: dipakai untuk purge per URL
  saat respons Vercel menunjukkan status selain `HIT` dan `N/A`.

Timeout pengiriman berarti respons belum dikonfirmasi; data bisa saja sudah
tersimpan di Sheets. Skrip tidak mengulang POST otomatis. Periksa tab run atau
Apps Script → Executions sebelum mengirim ulang.

## Purge Cloudflare berdasarkan status Vercel

Setelah request halaman berhasil, skrip memeriksa header `x-vercel-cache`.
Nilai dinormalisasi menjadi huruf besar dan spasi di tepinya dibuang.

- `HIT`: tidak melakukan purge.
- `N/A`, header kosong, atau header tidak tersedia: tidak melakukan purge.
- Status lain, misalnya `MISS`, `STALE`, atau `BYPASS`: mengirim satu request
  purge untuk URL halaman itu saja menggunakan `{ files: [url] }`.

Purge memakai `CLOUDFLARE_ZONE_ID` dan `CLOUDFLARE_API_TOKEN` di `.env`, atau
secret yang sama di workflow GitHub Actions. Token memerlukan izin **Cache Purge**
untuk zone tersebut sesuai [dokumentasi Cloudflare](https://developers.cloudflare.com/api/resources/cache/methods/purge/).
Request purge memiliki timeout 20 detik dan tidak diulang otomatis.

Hasil purge dicatat di terminal dan kolom `message` pada baris halaman yang sama.
Jika purge gagal atau kredensial belum tersedia, `error` bernilai 1, sementara
`status` tetap menunjukkan hasil request halaman. Kolom cache berisi header yang
diterima sebelum purge. Halaman tidak diminta ulang setelah purge; request berikutnya
ke URL tersebut yang akan mengisi cache Cloudflare lagi.

## Sitemap

Skrip membaca `/sitemap.xml` terlebih dahulu dan mencoba `/sitemap_index.xml`
jika sumber pertama gagal atau tidak menghasilkan URL. Keduanya mendukung
`urlset` langsung maupun `sitemapindex` bertingkat. URL halaman duplikat hanya
diproses sekali; sitemap yang sudah dikunjungi tidak diulang.

Kesalahan sitemap dicatat ke terminal dan baris logging Sheets. Jika semua sumber
gagal atau tidak menghasilkan URL, proses berhenti dengan exit code 1.

## Kolom Sheets

Payload POST berisi `{ sheetName, headers, rows }`. Urutan kolom:

| Kolom | Label | Isi |
| --- | --- | --- |
| A | `run_id` | ID eksekusi |
| B | `started_at` | Waktu mulai UTC |
| C | `finished_at` | Waktu selesai UTC |
| D | `country` | Kode edge Cloudflare pada request berhasil; kode konfigurasi `id` pada ringkasan/error, mengikuti perilaku sebelumnya |
| E | `url` | URL halaman/sitemap |
| F | `status` | Status HTTP |
| G | `cf_cache` | Header `cf-cache-status` |
| H | `vercel_cache` | Header `x-vercel-cache`, menggantikan `ls_cache` |
| I | `cf_ray` | Header `cf-ray` |
| J | `response_ms` | Durasi request dalam milidetik |
| K | `error` | 1 jika error, 0 jika berhasil |
| L | `message` | Ringkasan atau pesan error |
| M | `nextjs_cache` | Header `x-nextjs-cache` |

Header cache yang tidak dikirim server ditulis sebagai `N/A` pada baris request.
Status Vercel/Next.js berasal dari header respons yang diterima; ketika Cloudflare
melayani salinan cache, header tersebut bukan pengukuran baru ke origin.

## Memperbarui Apps Script penerima

Mengubah nama field di Node.js saja tidak memperbarui label pada penerima lama
yang memakai header tetap. Kode penerima yang siap dipasang ada di `appscript.gs`.

1. Buka proyek Apps Script yang URL `/exec`-nya dipakai oleh `APPS_SCRIPT_URL`.
2. Simpan salinan kode penerima lama, lalu ganti kode penerima dengan `appscript.gs`.
   Jangan menambahkan fungsi `doPost` kedua. Kebijakan penghapusan tab lama dijelaskan di bawah.
   Jika penerima lama dipakai juga oleh proyek lain, buat deployment/proyek khusus
   divemaster agar skema proyek lain tetap bisa dipakai.
3. Di **Project Settings → Script properties**, isi `SPREADSHEET_ID` dengan ID
   spreadsheet tujuan (bagian antara `/d/` dan `/edit` pada URL Sheets).
4. Pilih **Deploy → Manage deployments → Edit → New version → Deploy** untuk
   deployment khusus divemaster yang sudah ada. Jika membuat deployment baru,
   sesuaikan `APPS_SCRIPT_URL` lokal dan secret GitHub Actions dengan URL barunya.
   Pertahankan pengaturan akses yang memungkinkan skrip Node.js melakukan POST.
5. Jalankan `npm run start`. Tab run baru akan memakai 13 kolom di atas.
   Respons penerima yang menolak payload akan membuat proses gagal.

Langkah deployment mengikuti [dokumentasi Google Apps Script](https://developers.google.com/apps-script/concepts/deployments).
Pemasangan/deployment penerima di Google belum dilakukan otomatis dari repository ini.

## Penghapusan tab lama

`appscript.gs` mempertahankan maksimal **30 tab run** setelah penulisan berhasil.
Tab run dikenali dari nama `YYYY-MM-DD_HH-mm-ss_WITA`, termasuk akhiran lama
seperti `_WITA-2`, dan diurutkan berdasarkan waktu pada nama tersebut. Tab dengan
nama lain tidak ikut dihitung atau dihapus. Tab tujuan request selalu dilewati;
spreadsheet tetap memiliki minimal satu tab.

Jika pembuatan tab atau penulisan ditolak karena batas jumlah sel, penerima
menghapus hingga **5 tab run terlama**, lalu mencoba kembali, maksimal **3 kali**.
Error izin, kuota request, atau format data tidak memicu cleanup darurat. Jika
tidak ada tab yang bisa dihapus atau retry habis, respons berisi `ok: false`.
Daftar tab yang dihapus saat request berhasil dikembalikan sebagai `deletedSheets`.

Angka-angka ini dapat diubah lewat `MAX_RUN_SHEETS`, `SHEETS_TO_DELETE`, dan
`MAX_CLEANUP_RETRIES` di bagian atas `appscript.gs`. Cleanup berjalan di dalam
script lock yang sama dengan penulisan. Deploy versi Apps Script terbaru untuk
mengaktifkannya; perubahan lokal ini belum menghapus tab di Google Sheets.

## Pemeriksaan lokal

```powershell
npm test
```

Pengujian memakai respons sitemap/HTTP dan spreadsheet tiruan, tanpa menyalakan
server, mengirim data ke Sheets, atau melakukan purge.
