# Instalar o Pandu

O Pandu é um gravador de voos local e uma torre de controle para agentes de
programação com IA. Ele roda no seu computador, registra o que seus agentes
fazem e mantém cada voo, configuração e dispositivo pareado na sua máquina. Não
há conta, sincronização na nuvem nem telemetria.

Este guia cobre o aplicativo para Windows, o companheiro Android, o aplicativo
web instalável (PWA) e a ferramenta de linha de comando. Todos os comandos são
seguros para copiar e colar. O guia em inglês [`en.md`](en.md) é a referência
completa em caso de divergência.

**Conteúdo**

- [O que você precisa](#o-que-você-precisa)
- [Aplicativo para Windows](#aplicativo-para-windows)
- [Companheiro Android](#companheiro-android)
- [Aplicativo web instalável (PWA)](#aplicativo-web-instalável-pwa)
- [Ferramenta de linha de comando](#ferramenta-de-linha-de-comando)
- [Solução de problemas](#solução-de-problemas)

## O que você precisa

| Parte | Requisitos |
| --- | --- |
| Aplicativo Windows | Windows 10 ou 11, 64 bits. Microsoft Edge WebView2 (incluído no Windows atual; o instalador pode baixá-lo). |
| Companheiro Android | Android 10 ou mais recente. Um caminho de rede do celular até o computador: `tailscale serve` ou outro túnel HTTPS. |
| PWA | Um Chrome, Edge, Safari ou Firefox atual. A página precisa ser servida por HTTPS. |
| Computador executando o Pandu | Windows, macOS ou Linux para o daemon e a CLI. A interface desktop é exclusiva do Windows nesta versão. |

Você **não** precisa de direitos de administrador para o instalador recomendado
do Windows e **não** precisa de conta em lugar nenhum.

## Aplicativo para Windows

### Escolha o arquivo

Baixe estes arquivos na mesma página de release do GitHub. Não misture arquivos
de releases diferentes.

| Arquivo | Use quando |
| --- | --- |
| `Pandu_0.2.0_x64-setup.exe` | **Recomendado.** Instalação por usuário, sem pedir administrador. |
| `Pandu_0.2.0_x64_en-US.msi` | Você distribui software para uma organização. Instalação por máquina; exige administrador. |
| `pandu-0.2.0-x86_64-pc-windows-msvc-portable.zip` | Você não quer instalador. Extraia e execute. |

O número da versão no nome do arquivo muda a cada release. Use o release estável
mais recente, a menos que as notas digam outra coisa.

### Verifique o download primeiro

Cada release inclui um arquivo `SHA256SUMS`. Baixe-o na mesma pasta do
instalador e abra o PowerShell nessa pasta:

```powershell
Get-FileHash .\Pandu_0.2.0_x64-setup.exe -Algorithm SHA256
Get-Content .\SHA256SUMS | Select-String 'Pandu_0.2.0_x64-setup.exe'
```

Os dois hashes precisam ser idênticos. Se não forem, apague o arquivo e baixe de
novo. Não execute um arquivo cujo hash não confere, mesmo que a página pareça
oficial.

### Instalar (recomendado, por usuário)

1. Dê um duplo clique em `Pandu_0.2.0_x64-setup.exe`.
2. Se o Windows mostrar **Windows protected your PC**, escolha **More info** e
   depois **Run anyway**. Faça isso apenas quando o arquivo vier da página
   oficial do release e o SHA-256 tiver conferido no passo anterior. Builds de
   release não são assinados, a menos que as notas informem o uso de um
   certificado Authenticode.
3. Siga o instalador. Ele instala para a sua conta de usuário e não pede
   direitos de administrador.
4. Se o WebView2 estiver faltando, o instalador baixa o Evergreen bootstrapper
   da Microsoft. Esta é a única vez que o instalador precisa de internet.
5. Abra o Pandu pelo menu Iniciar.

O instalador não adiciona entrada de inicialização. A inicialização automática
fica **desligada por padrão**.

### Primeira execução

A janela do Pandu abre e inicia o daemon local. O daemon escuta em uma porta
loopback livre, então só é acessível pelo seu computador. A interface vem
embutida no aplicativo; o Pandu não carrega conteúdo web remoto.

- **Fechar a janela não encerra.** O Pandu continua na área de notificação para
  seguir gravando. Use o ícone da bandeja para reabrir.
- **Encerrar é explícito.** Clique com o botão direito no ícone da bandeja e
  escolha **Quit Pandu**. Depois de encerrar, os agentes não serão gravados até
  você iniciar o Pandu de novo.
- **Seus dados** ficam em `%USERPROFILE%\.pandu`. O banco é
  `%USERPROFILE%\.pandu\v2\pandu.db`; configurações, snapshots e backups ficam
  na mesma árvore.

### Desinstalar

1. Encerre o Pandu pela bandeja.
2. Abra **Settings > Apps > Installed apps**, encontre **Pandu** e escolha
   **Uninstall**.
3. O desinstalador pergunta se deve apagar `%USERPROFILE%\.pandu`. O padrão é
   **No**. Escolha **No** para manter voos, configurações, snapshots, backups e
   dispositivos pareados. Escolha **Yes** apenas se quiser apagá-los de vez.

A limpeza completa está em [`uninstall.md`](uninstall.md).

## Companheiro Android

O companheiro é um painel pequeno e limitado para o celular. Ele pode assistir
aos voos e responder a pedidos de aprovação, mas não pode iniciar agentes nem
alterar configurações. É opcional.

**Experimental:** o companheiro Android foi verificado em um emulador, mas ainda
não em um celular real. O APK não é anexado aos releases até a verificação no
celular ser registrada; compile a partir do código-fonte se quiser testar.

Resumo:

1. No computador, abra **Settings > Remote access** e ative o acesso remoto.
   Escolha o modo Tailscale e execute o comando `tailscale serve` que o Pandu
   mostrar.
2. Compile o APK a partir do código-fonte (experimental); veja
   [`android.md`](android.md).
3. Permita que o navegador ou gerenciador de arquivos instale apps desconhecidos
   e abra o APK.
4. Abra o Pandu no celular e escaneie o QR code de pareamento exibido no
   computador.
5. Aprove o dispositivo no computador. Dispositivos novos começam apenas com
   **Status**.

O guia completo, com permissões, bateria, canais de notificação e verificação
com `apksigner`, está em [`android.md`](android.md).

## Aplicativo web instalável (PWA)

O PWA é o mesmo painel remoto, instalado pelo navegador. Ele precisa de uma URL
HTTPS que chegue ao seu computador, normalmente criada com `tailscale serve`.

1. Ative o acesso remoto no computador e inicie `tailscale serve`.
2. Abra a URL HTTPS no celular ou em outro computador.
3. No menu do navegador, escolha **Install app** ou **Add to Home Screen**.
4. Pareie o dispositivo com o código exibido no computador.

O guia completo, com regras de cache e limitações, está em [`pwa.md`](pwa.md).

## Ferramenta de linha de comando

A CLI `pandu` é separada do aplicativo desktop. Instale se quiser rodar o daemon
por conta própria, usar `pandu run -- <agent>` ou executar diagnósticos.

1. Baixe `pandu-cli-x86_64-pc-windows-msvc.zip` e `SHA256SUMS`.
2. Verifique o arquivo com `Get-FileHash`, como mostrado acima.
3. Extraia. O zip contém a pasta `pandu-cli-x86_64-pc-windows-msvc` com
   `pandu.exe`.
4. Coloque essa pasta no `PATH` ou execute `pandu.exe` pelo caminho completo.

O release também inclui `pandu-cli-installer.ps1`, que instala a CLI para o
usuário atual. Leia o script antes de executar se quiser saber exatamente onde
ele grava.

Primeiros comandos úteis:

```powershell
pandu doctor
pandu serve
pandu pair
```

`pandu doctor` verifica o banco, os adaptadores, o observador de logs e um daemon
em execução. Ele imprime apenas informações locais. `pandu pair` imprime um
código de pareamento de curta duração e a URL remota para usar no celular.

## Solução de problemas

Se algo não funcionar, leia [`troubleshooting.md`](troubleshooting.md). Ele cobre
SmartScreen, WebView2, conflitos de porta, avisos de firewall, falhas de
pareamento, problemas de notificação e como redefinir o Pandu sem perder dados.

## Privacidade em um parágrafo

O Pandu grava localmente. O aplicativo desktop fala apenas com o daemon em
loopback. O acesso remoto fica desligado por padrão e só pode ser ativado pelo
computador. A verificação de atualizações é uma requisição HTTPS ao GitHub no
máximo uma vez a cada 24 horas e pode ser desligada. Não há telemetria,
sincronização na nuvem nem envio em segundo plano. A declaração completa está em
[`privacy.md`](../privacy.md).
