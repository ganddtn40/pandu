# Instalar Pandu

Pandu es una caja negra local y una torre de control para agentes de
programación con IA. Se ejecuta en tu ordenador, registra lo que hacen tus
agentes y guarda todos los vuelos, ajustes y dispositivos vinculados en tu
máquina. No hay cuenta, ni sincronización en la nube, ni telemetría.

Esta guía cubre la aplicación de escritorio para Windows, el compañero de
Android y la aplicación web instalable (PWA). Cada comando se puede copiar.

**Contenido**

- [Lo que necesitas](#lo-que-necesitas)
- [Aplicación de escritorio para Windows](#aplicación-de-escritorio-para-windows)
- [Compañero de Android](#compañero-de-android)
- [Aplicación web (PWA)](#aplicación-web-pwa)
- [Herramienta de línea de comandos](#herramienta-de-línea-de-comandos)
- [Solución de problemas](#solución-de-problemas)

## Lo que necesitas

| Parte | Requisitos |
| --- | --- |
| Aplicación Windows | Windows 10 u 11, 64 bits. Microsoft Edge WebView2 (incluido en Windows actual; el instalador puede descargarlo). |
| Compañero Android | Android 10 o posterior. Una ruta de red del teléfono al ordenador: `tailscale serve` u otro túnel HTTPS. |
| PWA | Chrome, Edge, Safari o Firefox actuales. La página debe servirse por HTTPS. |
| Ordenador con Pandu | Windows, macOS o Linux para el daemon y la CLI. El shell de escritorio es solo para Windows en esta versión. |

**No** necesitas derechos de administrador para el instalador recomendado de
Windows y **no** necesitas ninguna cuenta.

## Aplicación de escritorio para Windows

### Elige el archivo

Descárgalo de la misma página de lanzamientos de GitHub. No mezcles archivos de
versiones distintas.

| Archivo | Úsalo cuando |
| --- | --- |
| `Pandu_0.2.0_x64-setup.exe` | **Recomendado.** Instalación por usuario, sin aviso de administrador. |
| `Pandu_0.2.0_x64_en-US.msi` | Despliegas software para una organización. Instalación por equipo; requiere administrador. |
| `pandu-0.2.0-x86_64-pc-windows-msvc-portable.zip` | No quieres instalador. Extrae y ejecuta. |

El número de versión cambia en cada lanzamiento. Usa la versión estable más
reciente salvo que las notas digan otra cosa.

### Verifica la descarga primero

Cada versión incluye `SHA256SUMS`. Descárgalo junto al instalador y abre
PowerShell en esa carpeta:

```powershell
Get-FileHash .\Pandu_0.2.0_x64-setup.exe -Algorithm SHA256
Get-Content .\SHA256SUMS | Select-String 'Pandu_0.2.0_x64-setup.exe'
```

Los dos hashes deben coincidir exactamente. Si no coinciden, borra el archivo y
vuelve a descargarlo. No ejecutes un archivo cuyo hash no coincida, aunque la
página parezca oficial.

### Instalar (recomendado, por usuario)

1. Haz doble clic en `Pandu_0.2.0_x64-setup.exe`.
2. Si Windows muestra **Windows protected your PC**, elige **More info** y
   luego **Run anyway**. Hazlo solo si el archivo vino de la página oficial y su
   SHA-256 coincidió. Las compilaciones de lanzamiento no están firmadas salvo
   que las notas indiquen un certificado Authenticode.
3. Sigue el instalador. Se instala para tu cuenta y no pide administrador.
4. Si falta WebView2, el instalador descarga el bootstrapper Evergreen de
   Microsoft. Es la única vez que necesita internet.
5. Inicia Pandu desde el menú Inicio.

El instalador no añade una entrada de inicio automático. El inicio automático
está **desactivado por defecto**.

### Primer inicio

La ventana de Pandu se abre y arranca el daemon local. El daemon escucha en un
puerto de loopback libre, así que solo es accesible desde tu ordenador. La
interfaz está incluida en la aplicación; Pandu no carga contenido web remoto.

- **Cerrar la ventana no es salir.** Pandu sigue en el área de notificación
  para seguir grabando. Usa el icono de la bandeja para reabrirla.
- **Salir es explícito.** Haz clic derecho en el icono y elige **Quit Pandu**.
- **Inicio automático.** Marca **Start Pandu with Windows** en el menú de la
  bandeja si quieres que se inicie al entrar. Desmárcalo para desactivarlo.
- **Tus datos** están en `%USERPROFILE%\.pandu`. La base de datos es
  `%USERPROFILE%\.pandu\v2\pandu.db`; los ajustes, instantáneas y copias de
  seguridad están en el mismo árbol.

### Enlaces profundos

Pandu registra el esquema `pandu://`. Un enlace como
`pandu://flights/<flight-id>` abre la aplicación en ese vuelo. Los enlaces se
validan: las rutas desconocidas y los segmentos inseguros se ignoran. Pandu
nunca abre páginas remotas arbitrarias desde un enlace.

### MSI para despliegue gestionado

El MSI es una instalación por equipo para departamentos de TI que ya usan
Directiva de grupo, Intune u otro gestor de paquetes.

- Requiere derechos de administrador.
- Se instala para todos los usuarios del equipo.
- Los datos siguen en el `%USERPROFILE%\.pandu` de cada usuario.
- La pregunta de NSIS sobre borrar datos no se aplica al MSI. Tras desinstalar
  el MSI, borra `%USERPROFILE%\.pandu` manualmente solo si también quieres
  eliminar vuelos y ajustes.

### Versión portátil

1. Extrae `pandu-0.2.0-x86_64-pc-windows-msvc-portable.zip` en una carpeta tuya.
2. Ejecuta `Pandu.exe`. No hace falta instalador ni administrador.
3. WebView2 debe estar instalado. Windows actual lo incluye; si Pandu no
   arranca, instala Evergreen Runtime desde
   <https://developer.microsoft.com/microsoft-edge/webview2/>.
4. Para eliminarlo, sal de la bandeja, borra la carpeta y borra
   `%USERPROFILE%\.pandu` solo si también quieres tus datos.

### Desinstalar

1. Sal de Pandu desde la bandeja.
2. Abre **Configuración > Aplicaciones > Aplicaciones instaladas**, busca
   **Pandu** y elige **Desinstalar**.
3. El desinstalador pregunta si borrar `%USERPROFILE%\.pandu`. Por defecto es
   **No**. Elige **No** para conservar vuelos, ajustes, instantáneas, copias y
   dispositivos vinculados. Elige **Sí** solo si quieres eliminarlos para
   siempre.
4. Las desinstalaciones silenciosas siempre conservan los datos.

## Compañero de Android

El compañero es un panel pequeño y limitado para el teléfono. Puede ver vuelos
y responder solicitudes de aprobación, pero no puede iniciar agentes ni cambiar
ajustes. Es opcional.

Resumen:

1. En el ordenador, abre **Settings > Remote access** y activa el acceso
   remoto. Elige el modo Tailscale y ejecuta el comando `tailscale serve` que
   muestra Pandu.
2. Descarga el APK firmado de la misma página de lanzamientos.
3. Permite que tu navegador o gestor de archivos instale apps desconocidas y
   abre el APK.
4. Abre Pandu en el teléfono y escanea el QR del ordenador.
5. Aprueba el dispositivo en el ordenador. Los dispositivos nuevos empiezan con
   **Status** solamente.

La guía completa, con permisos, batería, canales de notificación y verificación
con `apksigner`, está en [android.md](android.md).

## Aplicación web (PWA)

La PWA es el mismo panel remoto, instalado desde el navegador. Necesita una URL
HTTPS que llegue a tu ordenador, normalmente mediante `tailscale serve`.

Resumen:

1. Activa el acceso remoto en el ordenador e inicia `tailscale serve`.
2. Abre la URL HTTPS en el teléfono u otro ordenador.
3. Usa el menú del navegador y elige **Instalar aplicación** o **Añadir a
   pantalla de inicio**.
4. Vincula el dispositivo con el código que muestra el ordenador.

La guía completa, con las reglas de caché y limitaciones, está en
[pwa.md](pwa.md).

## Herramienta de línea de comandos

La CLI `pandu` es independiente de la aplicación de escritorio. Instálala si
quieres ejecutar el daemon tú mismo, usar `pandu run -- <agente>` o ejecutar
diagnósticos.

1. Descarga `pandu-cli-x86_64-pc-windows-msvc.zip` y `SHA256SUMS`.
2. Verifica el archivo con `Get-FileHash`, como arriba.
3. Extráelo. El zip contiene una carpeta
   `pandu-cli-x86_64-pc-windows-msvc` con `pandu.exe`.
4. Añade esa carpeta al `PATH` o ejecuta `pandu.exe` con la ruta completa.

La versión también incluye `pandu-cli-installer.ps1`, que instala la CLI para el
usuario actual. Lee el script antes de ejecutarlo si quieres saber exactamente
dónde escribe.

Primeros comandos útiles:

```powershell
pandu doctor
pandu serve
pandu pair
```

`pandu doctor` comprueba la base de datos, los adaptadores, el vigilante de
registros y un daemon en ejecución. `pandu pair` imprime un código de
vinculación de corta duración y la URL remota para el teléfono.

## Solución de problemas

Si algo no funciona, lee [troubleshooting.md](troubleshooting.md). Cubre
SmartScreen, WebView2, conflictos de puertos, avisos del firewall, fallos de
vinculación, problemas de notificaciones y cómo restablecer Pandu sin perder
datos.

### Resumen rápido

- **SmartScreen:** verifica el SHA-256 y elige **More info > Run anyway** solo
  para archivos de la versión oficial.
- **Falta WebView2:** instala Evergreen Runtime de Microsoft y reinicia Pandu.
- **No se puede instalar el APK:** permite **Install unknown apps** solo para el
  navegador o gestor de archivos que uses y vuelve a intentarlo.
- **Notificaciones de Android con retraso:** WorkManager comprueba como máximo
  cada 15 minutos. Pon la batería en **Unrestricted** y no silencies el canal
  que necesitas.
- **La PWA no se instala:** comprueba que la página usa HTTPS y usa Chrome, Edge
  o Safari.

## Privacidad en un párrafo

Pandu graba localmente. La aplicación de escritorio solo habla con el daemon en
loopback. El acceso remoto está desactivado por defecto y solo puede activarse
desde el ordenador. La comprobación de actualizaciones es una petición HTTPS a
GitHub como máximo cada 24 horas y se puede desactivar. No hay telemetría, ni
sincronización en la nube, ni subidas en segundo plano. Consulta
[privacy.md](../privacy.md) para la declaración completa.
