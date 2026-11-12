# Memasang Pandu

Pandu adalah perekam penerbangan lokal dan menara kontrol untuk agen pengkode
AI. Pandu berjalan di komputer Anda, merekam apa yang dilakukan agen, dan
menyimpan semua penerbangan, pengaturan, serta perangkat yang dipasangkan di
mesin Anda. Tidak ada akun, tidak ada sinkronisasi cloud, dan tidak ada
telemetri.

Panduan ini mencakup aplikasi desktop Windows, pendamping Android, dan aplikasi
web yang dapat dipasang (PWA). Setiap perintah aman untuk disalin.

**Daftar isi**

- [Yang Anda butuhkan](#yang-anda-butuhkan)
- [Aplikasi desktop Windows](#aplikasi-desktop-windows)
- [Pendamping Android](#pendamping-android)
- [Aplikasi web (PWA)](#aplikasi-web-pwa)
- [Alat baris perintah](#alat-baris-perintah)
- [Pemecahan masalah](#pemecahan-masalah)

## Yang Anda butuhkan

| Bagian | Persyaratan |
| --- | --- |
| Aplikasi Windows | Windows 10 atau 11, 64-bit. Microsoft Edge WebView2 (sudah ada di Windows terbaru; penginstal dapat mengunduhnya). |
| Pendamping Android | Android 10 atau lebih baru. Jalur jaringan dari ponsel ke komputer: `tailscale serve` atau terowongan HTTPS lain. |
| PWA | Chrome, Edge, Safari, atau Firefox terbaru. Halaman harus disajikan melalui HTTPS. |
| Komputer yang menjalankan Pandu | Windows, macOS, atau Linux untuk daemon dan CLI. Shell desktop hanya untuk Windows pada rilis ini. |

Anda **tidak** memerlukan hak administrator untuk penginstal Windows yang
direkomendasikan, dan Anda **tidak** memerlukan akun di mana pun.

## Aplikasi desktop Windows

### Pilih berkas

Unduh dari halaman rilis GitHub yang sama. Jangan mencampur berkas dari rilis
berbeda.

| Berkas | Gunakan saat |
| --- | --- |
| `Pandu_0.2.0_x64-setup.exe` | **Direkomendasikan.** Pemasangan per pengguna, tanpa prompt administrator. |
| `Pandu_0.2.0_x64_en-US.msi` | Anda men-deploy perangkat lunak untuk organisasi. Pemasangan per mesin; butuh hak administrator. |
| `pandu-0.2.0-x86_64-pc-windows-msvc-portable.zip` | Anda tidak ingin penginstal sama sekali. Ekstrak lalu jalankan. |

Nomor versi berubah di setiap rilis. Gunakan rilis stabil terbaru kecuali
catatan rilis menyatakan lain.

### Verifikasi unduhan terlebih dahulu

Setiap rilis menyertakan `SHA256SUMS`. Unduh berkas itu ke folder yang sama,
lalu buka PowerShell di folder tersebut:

```powershell
Get-FileHash .\Pandu_0.2.0_x64-setup.exe -Algorithm SHA256
Get-Content .\SHA256SUMS | Select-String 'Pandu_0.2.0_x64-setup.exe'
```

Kedua hash harus sama persis. Jika tidak, hapus berkas dan unduh ulang. Jangan
jalankan berkas yang hash-nya tidak cocok, meskipun halamannya terlihat resmi.

### Pasang (direkomendasikan, per pengguna)

1. Klik dua kali `Pandu_0.2.0_x64-setup.exe`.
2. Jika Windows menampilkan **Windows protected your PC**, pilih **More info**,
   lalu **Run anyway**. Lakukan ini hanya jika berkas berasal dari halaman rilis
   resmi dan SHA-256-nya cocok. Build rilis tidak ditandatangani kecuali catatan
   rilis menyebutkan sertifikat Authenticode.
3. Ikuti penginstal. Pandu dipasang untuk akun Anda dan tidak meminta hak
   administrator.
4. Jika WebView2 belum ada, penginstal mengunduh bootstrapper Evergreen
   Microsoft. Ini satu-satunya saat penginstal membutuhkan internet.
5. Jalankan Pandu dari menu Start.

Penginstal tidak menambahkan entri startup. Autostart **mati secara default**.

### Peluncuran pertama

Jendela Pandu terbuka dan menjalankan daemon lokal. Daemon mendengarkan pada
port loopback bebas, sehingga hanya dapat diakses dari komputer Anda. UI
dibundel di dalam aplikasi; Pandu tidak memuat konten web jarak jauh.

- **Menutup jendela tidak berarti keluar.** Pandu tetap berjalan di area
  notifikasi agar terus merekam. Gunakan ikon tray untuk membukanya lagi.
- **Keluar harus eksplisit.** Klik kanan ikon tray dan pilih **Quit Pandu**.
- **Autostart.** Centang **Start Pandu with Windows** di menu tray jika ingin
  Pandu mulai saat masuk. Hapus centang untuk mematikan autostart.
- **Data Anda** berada di `%USERPROFILE%\.pandu`. Basis data ada di
  `%USERPROFILE%\.pandu\v2\pandu.db`; pengaturan, snapshot, dan cadangan berada
  di pohon yang sama.

### Tautan dalam (deep link)

Pandu mendaftarkan skema URL `pandu://`. Tautan seperti
`pandu://flights/<flight-id>` membuka aplikasi desktop pada penerbangan itu.
Tautan divalidasi: jalur yang tidak dikenal dan segmen tidak aman diabaikan.
Pandu tidak pernah membuka halaman jarak jauh sembarangan dari tautan.

### MSI untuk deployment terkelola

MSI adalah pemasangan per mesin untuk departemen TI yang sudah memakai Group
Policy, Intune, atau manajer paket lain.

- Butuh hak administrator.
- Dipasang untuk semua pengguna di komputer.
- Data pengguna tetap di `%USERPROFILE%\.pandu` masing-masing.
- Pertanyaan penghapusan data milik NSIS tidak berlaku untuk MSI. Setelah
  menghapus MSI, hapus `%USERPROFILE%\.pandu` secara manual hanya jika Anda
  juga ingin menghapus penerbangan dan pengaturan.

### Build portabel

1. Ekstrak `pandu-0.2.0-x86_64-pc-windows-msvc-portable.zip` ke folder milik
   Anda.
2. Jalankan `Pandu.exe`. Tidak perlu penginstal atau hak administrator.
3. WebView2 harus sudah terpasang. Windows terbaru menyertakannya; jika Pandu
   tidak mulai, pasang Evergreen Runtime dari
   <https://developer.microsoft.com/microsoft-edge/webview2/>.
4. Untuk menghapus, keluar dari tray, hapus foldernya, lalu hapus
   `%USERPROFILE%\.pandu` hanya jika Anda juga ingin menghapus data.

### Copot pemasangan

1. Keluar dari Pandu melalui tray.
2. Buka **Settings > Apps > Installed apps**, cari **Pandu**, pilih
   **Uninstall**.
3. Penginstal menanyakan apakah `%USERPROFILE%\.pandu` harus dihapus. Defaultnya
   **No**. Pilih **No** untuk menyimpan penerbangan, pengaturan, snapshot,
   cadangan, dan perangkat yang dipasangkan. Pilih **Yes** hanya jika Anda
   yakin ingin menghapusnya permanen.
4. Uninstall senyap selalu menyimpan folder data.

## Pendamping Android

Pendamping adalah dasbor kecil dengan cakupan terbatas untuk ponsel. Anda dapat
memantau penerbangan dan menjawab permintaan persetujuan, tetapi tidak dapat
memulai agen atau mengubah pengaturan. Fitur ini opsional.

**Eksperimental:** pendamping Android belum diverifikasi di emulator dan ponsel
fisik. APK belum dilampirkan ke rilis sampai verifikasi selesai; bangun dari
sumber jika ingin mencobanya.

Ringkasnya:

1. Di komputer, buka **Settings > Remote access** dan aktifkan akses jarak
   jauh. Pilih mode Tailscale dan jalankan perintah `tailscale serve` yang
   ditampilkan Pandu.
2. Bangun APK dari sumber (eksperimental); lihat [android.md](android.md).
3. Izinkan browser atau pengelola berkas memasang aplikasi dari sumber tidak
   dikenal, lalu buka APK.
4. Buka Pandu di ponsel dan pindai kode QR dari komputer.
5. Setujui perangkat di komputer. Perangkat baru hanya mendapat **Status**.

Panduan lengkap, termasuk izin, pengaturan baterai, saluran notifikasi, dan
verifikasi `apksigner`, ada di [android.md](android.md).

## Aplikasi web (PWA)

PWA adalah dasbor jarak jauh yang sama, dipasang dari browser. PWA memerlukan
URL HTTPS yang mencapai komputer Anda, biasanya dari `tailscale serve`.

Ringkasnya:

1. Aktifkan akses jarak jauh di komputer dan jalankan `tailscale serve`.
2. Buka URL HTTPS di ponsel atau komputer lain.
3. Gunakan menu browser dan pilih **Install app** atau **Add to Home Screen**.
4. Pasangkan perangkat dengan kode yang ditampilkan di komputer.

Panduan lengkap, termasuk aturan cache dan batasannya, ada di [pwa.md](pwa.md).

## Alat baris perintah

CLI `pandu` terpisah dari aplikasi desktop. Pasang jika Anda ingin menjalankan
daemon sendiri, memakai `pandu run -- <agent>`, atau menjalankan diagnostik.

1. Unduh `pandu-cli-x86_64-pc-windows-msvc.zip` dan `SHA256SUMS`.
2. Verifikasi arsip dengan `Get-FileHash` seperti di atas.
3. Ekstrak. `pandu.exe` berada di akar arsip.
4. Tambahkan folder hasil ekstrak ke `PATH`, atau jalankan `pandu.exe` dengan
   jalur lengkap.

Rilis juga menyertakan `pandu-cli-installer.ps1`, yang memasang CLI untuk
pengguna saat ini. Baca skripnya sebelum menjalankan jika Anda ingin tahu persis
ke mana ia menulis.

Perintah pertama yang berguna:

```powershell
pandu doctor
pandu serve
pandu pair
```

`pandu doctor` memeriksa basis data, adapter, pemantau log, dan daemon yang
berjalan. `pandu pair` mencetak kode pemasangan berumur pendek dan URL jarak
jauh untuk ponsel.

## Pemecahan masalah

Jika ada yang tidak berfungsi, baca [troubleshooting.md](troubleshooting.md).
Isinya mencakup SmartScreen, WebView2, konflik port, prompt firewall, kegagalan
pemasangan, masalah notifikasi, dan cara mengatur ulang Pandu tanpa kehilangan
data.

### Ringkasan cepat

- **SmartScreen:** verifikasi SHA-256, lalu **More info > Run anyway** hanya
  untuk berkas dari rilis resmi.
- **WebView2 hilang:** pasang Evergreen Runtime dari Microsoft, lalu mulai ulang
  Pandu.
- **Tidak bisa memasang APK:** izinkan **Install unknown apps** hanya untuk
  browser atau pengelola berkas yang Anda pakai, lalu coba lagi.
- **Notifikasi Android terlambat:** WorkManager memeriksa maksimal setiap 15
  menit. Atur baterai ke **Unrestricted** dan jangan mematikan saluran
  notifikasi yang Anda butuhkan.
- **PWA tidak bisa dipasang:** pastikan halaman dibuka melalui HTTPS dan gunakan
  Chrome, Edge, atau Safari.

## Privasi dalam satu paragraf

Pandu merekam secara lokal. Aplikasi desktop hanya berbicara dengan daemon di
loopback. Akses jarak jauh mati secara default dan hanya dapat diaktifkan dari
komputer. Pemeriksaan pembaruan adalah satu permintaan HTTPS ke GitHub paling
banyak sekali setiap 24 jam dan dapat dimatikan. Tidak ada telemetri, tidak ada
sinkronisasi cloud, dan tidak ada unggahan latar belakang. Lihat
[privacy.md](../privacy.md) untuk pernyataan lengkap.
