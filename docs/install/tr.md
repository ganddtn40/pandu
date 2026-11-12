# Pandu'yu yükleme

Pandu, yapay zekâ kodlama ajanları için yerel bir uçuş kaydedici ve kontrol
kulesidir. Bilgisayarınızda çalışır, ajanlarınızın ne yaptığını kaydeder ve her
uçuşu, ayarı ve eşleştirilmiş cihazı makinenizde tutar. Hesap, bulut eşitlemesi
ve telemetri yoktur.

Bu kılavuz Windows masaüstü uygulamasını, Android yardımcı uygulamasını,
kurulabilir web uygulamasını (PWA) ve komut satırı aracını kapsar. Tüm komutlar
kopyalayıp yapıştırmak için güvenlidir. Bir çelişki olursa İngilizce kılavuz
[`en.md`](en.md) tam referanstır.

**İçindekiler**

- [Neye ihtiyacınız var](#neye-ihtiyacınız-var)
- [Windows masaüstü uygulaması](#windows-masaüstü-uygulaması)
- [Android yardımcı uygulaması](#android-yardımcı-uygulaması)
- [Kurulabilir web uygulaması (PWA)](#kurulabilir-web-uygulaması-pwa)
- [Komut satırı aracı](#komut-satırı-aracı)
- [Sorun giderme](#sorun-giderme)

## Neye ihtiyacınız var

| Bölüm | Gereksinimler |
| --- | --- |
| Windows uygulaması | Windows 10 veya 11, 64 bit. Microsoft Edge WebView2 (güncel Windows'ta bulunur; yükleyici indirebilir). |
| Android yardımcı uygulaması | Android 10 veya üzeri. Telefondan bilgisayara ağ yolu: `tailscale serve` veya başka bir HTTPS tüneli. |
| PWA | Güncel Chrome, Edge, Safari veya Firefox. Sayfa HTTPS üzerinden sunulmalıdır. |
| Pandu'yu çalıştıran bilgisayar | Daemon ve CLI için Windows, macOS veya Linux. Bu sürümde masaüstü kabuğu yalnızca Windows içindir. |

Önerilen Windows yükleyicisi için yönetici hakları **gerekmez** ve hiçbir yerde
hesap **gerekmez**.

## Windows masaüstü uygulaması

### Dosyayı seçin

Bunları aynı GitHub sürüm sayfasından indirin. Farklı sürümlerin dosyalarını
karıştırmayın.

| Dosya | Ne zaman kullanılır |
| --- | --- |
| `Pandu_0.2.0_x64-setup.exe` | **Önerilir.** Kullanıcı başına kurulum, yönetici istemi yok. |
| `Pandu_0.2.0_x64_en-US.msi` | Bir kuruluş için yazılım dağıtıyorsunuz. Makine geneli kurulum; yönetici hakları gerekir. |
| `pandu-0.2.0-x86_64-pc-windows-msvc-portable.zip` | Yükleyici istemiyorsunuz. Çıkarın ve çalıştırın. |

Dosya adındaki sürüm numarası her sürümde değişir. Sürüm notlarında aksi
belirtilmedikçe en yeni kararlı sürümü kullanın.

### Önce indirmeyi doğrulayın

Her sürümde `SHA256SUMS` adlı bir dosya bulunur. Yükleyiciyle aynı klasöre
indirin, sonra o klasörde PowerShell açın:

```powershell
Get-FileHash .\Pandu_0.2.0_x64-setup.exe -Algorithm SHA256
Get-Content .\SHA256SUMS | Select-String 'Pandu_0.2.0_x64-setup.exe'
```

İki karma değeri tam olarak eşleşmelidir. Eşleşmezse dosyayı silin ve yeniden
indirin. Sayfa resmî görünse bile karma değeri eşleşmeyen dosyayı çalıştırmayın.

### Kurulum (önerilir, kullanıcı başına)

1. `Pandu_0.2.0_x64-setup.exe` dosyasına çift tıklayın.
2. Windows **Windows protected your PC** gösterirse **More info** ve ardından
   **Run anyway** seçin. Bunu yalnızca dosya resmî sürüm sayfasından geldiyse ve
   önceki adımda SHA-256 eşleştiyse yapın. Sürüm notlarında Authenticode
   sertifikası kullanıldığı belirtilmedikçe sürüm derlemeleri imzasızdır.
3. Yükleyiciyi izleyin. Kullanıcı hesabınıza kurar ve yönetici hakları istemez.
4. WebView2 eksikse yükleyici Microsoft Evergreen bootstrapper'ı indirir.
   Yükleyicinin internete ihtiyaç duyduğu tek an budur.
5. Pandu'yu Başlat menüsünden açın.

Yükleyici başlangıç girdisi eklemez. Otomatik başlatma **varsayılan olarak
kapalıdır**.

### İlk çalıştırma

Pandu penceresi açılır ve yerel daemon başlar. Daemon boş bir loopback bağlantı
noktasında dinler, bu yüzden yalnızca bilgisayarınızdan erişilebilir. Arayüz
uygulamanın içine gömülüdür; Pandu uzak web içeriği yüklemez.

- **Pencereyi kapatmak uygulamayı kapatmaz.** Pandu kayda devam etmek için
  bildirim alanında çalışmayı sürdürür. Yeniden açmak için tepsi simgesini
  kullanın.
- **Çıkış açık bir eylemdir.** Tepsi simgesine sağ tıklayın ve **Quit Pandu**
  seçin. Çıkarsanız, Pandu'yu yeniden başlatana kadar ajanlar kaydedilmez.
- **Verileriniz** `%USERPROFILE%\.pandu` içinde yaşar. Veritabanı
  `%USERPROFILE%\.pandu\v2\pandu.db`; ayarlar, anlık görüntüler ve yedekler aynı
  ağaçtadır.

### Kaldırma

1. Pandu'yu tepsiden kapatın.
2. **Settings > Apps > Installed apps** açın, **Pandu** bulun ve **Uninstall**
   seçin.
3. Kaldırıcı `%USERPROFILE%\.pandu` dizininin silinip silinmeyeceğini sorar.
   Varsayılan **No**. Uçuşlarınızı, ayarlarınızı, anlık görüntülerinizi,
   yedeklerinizi ve eşleştirilmiş cihazlarınızı korumak için **No** seçin.
   Kalıcı olarak silmek istiyorsanız **Yes** seçin.

Tam temizlik [`uninstall.md`](uninstall.md) içindedir.

## Android yardımcı uygulaması

Yardımcı uygulama, telefonunuz için küçük ve sınırlı bir panodur. Uçuşları
izleyebilir ve onay isteklerini yanıtlayabilir, ancak ajan başlatamaz veya
ayarları değiştiremez. İsteğe bağlıdır.

**Deneysel:** Android yardımcı uygulaması bir emülatörde doğrulandı, ancak henüz
gerçek bir telefonda doğrulanmadı. Telefon doğrulaması kaydedilene kadar APK
sürümlere eklenmez; denemek istiyorsanız kaynaktan derleyin.

Kısa sürüm:

1. Bilgisayarda **Settings > Remote access** açın ve uzak erişimi açın.
   Tailscale modunu seçin ve Pandu'nun gösterdiği `tailscale serve` komutunu
   çalıştırın.
2. APK'yı kaynaktan derleyin (deneysel); bkz. [`android.md`](android.md).
3. Tarayıcının veya dosya yöneticisinin bilinmeyen uygulamaları yüklemesine izin
   verin, sonra APK'yı açın.
4. Telefonda Pandu'yu açın ve bilgisayarda gösterilen eşleştirme QR kodunu
   tarayın.
5. Cihazı bilgisayarda onaylayın. Yeni cihazlar yalnızca **Status** ile başlar.

İzinler, pil ayarları, bildirim kanalları ve `apksigner` doğrulaması dahil tam
kılavuz [`android.md`](android.md) içindedir.

## Kurulabilir web uygulaması (PWA)

PWA, aynı uzak panonun tarayıcıdan kurulmuş halidir. Bilgisayarınıza ulaşan bir
HTTPS adresi gerekir; genellikle `tailscale serve` ile oluşturulur.

1. Bilgisayarda uzak erişimi açın ve `tailscale serve` başlatın.
2. Telefonda veya başka bir bilgisayarda HTTPS adresini açın.
3. Tarayıcı menüsünden **Install app** veya **Add to Home Screen** seçin.
4. Cihazı bilgisayarda gösterilen kodla eşleştirin.

Önbellek kuralları ve sınırlamalar dahil tam kılavuz [`pwa.md`](pwa.md)
içindedir.

## Komut satırı aracı

`pandu` CLI masaüstü uygulamasından ayrıdır. Daemon'u kendiniz çalıştırmak,
`pandu run -- <agent>` kullanmak veya tanılama çalıştırmak istiyorsanız kurun.

1. `pandu-cli-x86_64-pc-windows-msvc.zip` ve `SHA256SUMS` indirin.
2. Arşivi yukarıda gösterildiği gibi `Get-FileHash` ile doğrulayın.
3. Çıkarın. `pandu.exe` arşivin kökünde.
4. Çıkarma klasörünü `PATH`'e ekleyin veya `pandu.exe` dosyasını tam yoluyla çalıştırın.

Sürümde ayrıca CLI'yi geçerli kullanıcı için kuran `pandu-cli-installer.ps1`
bulunur. Tam olarak nereye yazdığını bilmek istiyorsanız betiği çalıştırmadan
önce okuyun.

İlk yararlı komutlar:

```powershell
pandu doctor
pandu serve
pandu pair
```

`pandu doctor` veritabanını, bağdaştırıcıları, günlük izleyicisini ve çalışan
daemon'u denetler. Yalnızca yerel bilgi yazdırır. `pandu pair` kısa ömürlü bir
eşleştirme kodu ve telefonda kullanılacak uzak URL yazdırır.

## Sorun giderme

Bir şey çalışmıyorsa [`troubleshooting.md`](troubleshooting.md) okuyun.
SmartScreen, WebView2, bağlantı noktası çakışmaları, güvenlik duvarı istemleri,
eşleştirme hataları, bildirim sorunları ve verilerinizi kaybetmeden Pandu'yu
sıfırlama burada anlatılır.

## Tek paragrafta gizlilik

Pandu yerel olarak kaydeder. Masaüstü uygulaması yalnızca loopback üzerindeki
daemon ile konuşur. Uzak erişim varsayılan olarak kapalıdır ve yalnızca
bilgisayardan açılabilir. Güncelleme denetimi GitHub'a en fazla 24 saatte bir
gönderilen tek bir HTTPS isteğidir ve kapatılabilir. Telemetri, bulut eşitlemesi
ve arka plan yüklemesi yoktur. Tam bildirim [`privacy.md`](../privacy.md)
içindedir.
