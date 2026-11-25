# Music Studio

Feito por [Felipe Leme](https://github.com/fzk-felipe) e [Vinicius Cambraia](https://github.com/ViniciusCambraia).


Gera vídeos longos (1h+) a partir de uma pasta de faixas: nivela o volume, faz crossfade,
coloca o fundo em loop (com correção de tremor de vídeos de IA) e o **audio visualizer**,
e gera a descrição com tracklist/capítulos. Requer **Node 20+** e **FFmpeg 7+** (build "full").

## Instalação (Windows 10/11)

1. No GitHub, **Code → Download ZIP** ou `git clone https://github.com/fzk-felipe/music-studio.git`.
2. Abra a pasta e dê **dois cliques em `instalar.cmd`** (instala Node e FFmpeg se faltarem e cria o atalho **Music Studio**).
3. Abra o atalho.

Músicas, vídeos, fontes e renders ficam fora do repositório. O canal `exemplo` serve de ponto de partida.

## Instalação em outro PC por zip

1. Copie o arquivo `msc-AAAA-MM-DD.zip` (gerado com `node scripts/empacotar.mjs`) para o outro PC e extraia.
2. Abra a pasta `msc` e dê **dois cliques em `instalar.cmd`**. Ele:
   - instala o **Node.js** e o **FFmpeg** pelo winget, se faltarem;
   - pergunta se deve registrar o comando `msc` para usar em qualquer pasta;
   - roda `msc verificar` no final.
3. Se pedir, feche e abra o terminal e rode `instalar.cmd` de novo (o Windows só enxerga programas recém-instalados em janelas novas).

**Placa de vídeo:** o programa escolhe sozinho o encoder mais rápido disponível — NVIDIA (NVENC) → Intel (QSV) →
AMD (AMF) → processador (libx264). Sem GPU funciona igual, só renderiza mais devagar.
Para forçar um, use `"encode": { "codec": "libx264" }` no project.json.

**Músicas e vídeos não vão no zip** (são GBs). Para levar tudo: `node scripts/empacotar.mjs --com-midia`
(leva tracks e backgrounds; os renders em `output/` nunca vão).

## Estrutura

```
channels/<canal>/channel.json     estilo padrão do canal (cores, visualizer, descrição, tags)
projects/<video>/project.json     um vídeo: título, fundo, faixas e ajustes de estilo
projects/<video>/background.mp4   vídeo (ou imagem) de fundo em loop
projects/<video>/tracks/          faixas (m4a/mp3/wav/flac) — a ordem segue o nome: "01 - Nome.m4a"
projects/<video>/output/          video.mp4, preview.mp4, description.txt
```

## App visual (recomendado)

Dois cliques no atalho **Music Studio** da Área de Trabalho (ou em `abrir-app.cmd`). Abre no navegador:

1. **+ Novo vídeo** → título e canal.
2. **Fundo**: arraste o vídeo do Google Flow para este projeto ou use a **Biblioteca de visuais** para importar imagens/vídeos de qualquer pasta e reutilizá-los em outros projetos. Clique em um item da biblioteca para aplicá-lo como fundo. Os arquivos importados ficam em `visuals/`; os estilos que reagem à música continuam na aba **Visualizer**.
3. **Músicas**: cole o link da playlist do Flow Music (baixa tudo) ou arraste os arquivos; arraste para reordenar, clique no nome para renomear. Em **Transição entre músicas**, escolha até 15 s de sobreposição suave ou 0 s para corte direto. Em **Som ambiente sob a música**, importe chuva, ondas ou outro áudio, ajuste o volume em dB, ative/desative ou remova. O ambiente se repete até o fim do vídeo, com entrada e saída suaves opcionais (0 s desliga cada uma). O player ▶ toca música e ambiente para conferir o volume; gere uma prévia para ouvir os fades no vídeo final.
4. **Visualizer** / **Textos**: ajuste olhando a prévia ao vivo (▶ numa música faz o visualizer reagir). O visualizer oferece **41 estilos pesquisáveis**, organizados em Barras e equalizadores, Ondas e curvas, Círculos e foto central, Partículas e raios. Cada estilo pode ser personalizado com cor, largura/altura, barras, brilho e outros controles; alguns são variações prontas dos mesmos desenhos. Em Textos, ative **Nome da música + barra de progresso** para mostrar o título com um marcador que avança; ative **Texto de Aviso** para editar livremente o aviso, escolher sua entrada, posição e se aparece uma vez ou se repete. Em **Fontes do sistema e importadas**, busque pelo nome, veja o exemplo, escolha **Aplicar em** e clique **Usar no texto escolhido**. Cada bloco de texto também tem seu seletor de fonte. Para adicionar uma fonte que não aparece no Windows, importe um ou vários arquivos `.ttf`/`.otf` de qualquer pasta. **Atualizar fontes** encontra fontes instaladas recentemente. Fontes importadas são copiadas para `fonts/` e usadas também no render. Ative o bloco de texto correspondente para ver a fonte na prévia. Tudo salva sozinho.
5. **Gerar prévia de 20 s** para conferir → **Gerar vídeo completo**. No fim, título/descrição/tags com botão de copiar.

Ferramentas adicionais: botão **Tela inteira** na prévia; **Ocupar quadro inteiro** no visualizer (para estilos lineares, largura/altura de 1920×1080; para circulares, ocupa a altura do quadro); linha do tempo para inspecionar a faixa/aviso em qualquer ponto; guias visuais de 5% (não aparecem no render); comparação A/B de duas prévias; modelos de visual por canal; painel de armazenamento que limpa somente cache e prévias. A aba **Fundo** permite escolher a emenda quando o vídeo/imagem se repete: corte, transição suave (para vídeos) ou passagem pelo preto, com duração ajustável. Também oferece entrada gradual do fundo. Visualizer (incluindo a foto central), textos, marca do canal e lembrete têm opções independentes de entrada. Nos estilos circulares, a seção **Foto no centro do círculo** aceita uma imagem PNG/JPG/WebP do computador ou da Biblioteca de visuais. O controle **Tamanho da foto** vai de 40% a 900% independentemente do raio do anel, tanto na prévia quanto no render. Quando a foto já cobre o quadro, o tamanho intermediário é limitado para evitar uso excessivo de memória. Acima de 100%, ela pode cobrir parte do visualizer. Espaço, raio e giro também são ajustáveis. O app marca vídeos desatualizados e faz uma verificação de áudio, vídeo, duração, thumbnail e canal antes de publicar.

**Comparação A/B:** ajuste o visual e clique **Guardar A**; faça outra versão e clique **Guardar B**; escolha o início do trecho e clique **Gerar comparação**. Dois MP4s de 20 s aparecem lado a lado. Os modelos ficam em `channels/<canal>/presets/` e não incluem as músicas ou o fundo. As guias e a posição escolhida na linha do tempo são apenas controles de edição.

**Segurança da publicação:** após cada render completo, `output/render-state.json` registra a identidade das configurações e mídias. Alterações posteriores marcam o vídeo como desatualizado. A verificação antes do envio consulta os streams e a duração do MP4 e examina uma amostra de 4 s no meio do vídeo para alertar sobre trechos escuros ou silenciosos; não substitui assistir ao vídeo completo. Avisos exigem confirmação. Uma sessão de envio interrompida fica em `.work/upload-session.json` (não enviada ao GitHub) até ser retomada ou descartada.

A janela preta que abre junto é o servidor do app — deixe aberta enquanto usa.
O endereço padrão é `http://127.0.0.1:43863`. Se a porta estiver ocupada, o app escolhe uma livre e abre o endereço correto no navegador. Para fixar outra porta, defina a variável de ambiente `MSC_PORT` antes de abrir o app.

### Adicionar canais

Clique em **+ Novo canal** para criar a pasta e o `channel.json` pelo app. Também é possível criar uma pasta manualmente em `channels/`: clique em **↻** ao lado de Canais e a pasta sem `channel.json` aparecerá com **configurar ⚙**. Clique nela para gerar a configuração dentro da própria pasta, sem apagar os outros arquivos. Pastas que já contêm um `channel.json` válido também aparecem após atualizar. Só canais configurados podem receber vídeos; o comando `msc novo` usa o primeiro canal configurado quando nenhum é informado.

## Enviar para o YouTube

No app, abaixo do vídeo pronto, fica o quadro **Publicar no YouTube** (título, descrição com capítulos, tags,
thumbnail feita por fora, Privado / Não listado / Público / Agendar).

**Configuração única** (o passo a passo aparece no próprio app):
1. Google Cloud: criar projeto → ativar **YouTube Data API v3**.
2. Google Auth Platform: tela de consentimento **Externo** → **Publicar app** (senão o acesso expira a cada 7 dias).
3. Criar cliente OAuth do tipo **App para computador** → baixar o JSON → enviar no app.
4. Pedir a **auditoria da API** (formulário grátis do YouTube). Até ser aprovada, todo vídeo enviado pela API fica **privado**.

**Cada canal conecta uma vez** (botão "Conectar" → escolher o canal certo na tela do Google). A conexão fica em
`channels/<canal>/youtube-token.json` e cada vídeo só sai pela conexão do canal dele. Credenciais e conexões
**não vão para o GitHub**. As cotas de envio variam conforme o projeto e devem ser consultadas no Google Cloud; o app não presume um número fixo de envios por dia. Envios interrompidos podem ser retomados enquanto a sessão do YouTube continuar válida.

## Uso pela linha de comando

Com o PATH registrado pelo instalador, use `msc` de qualquer pasta. Sem ele, rode `msc.cmd` dentro da pasta `msc`.

```bash
msc verificar                      # confere se o PC tem tudo
msc novo tarde-em-ipanema          # cria projects/tarde-em-ipanema (tracks/ + project.json)
msc preview tarde-em-ipanema       # trecho de 20 s p/ conferir o visual (output/preview.mp4)
msc build tarde-em-ipanema         # vídeo completo + output/description.txt
msc overlay tarde-em-ipanema       # só o visualizer em fundo preto, p/ o CapCut (modo "Tela")
msc compare tarde-em-ipanema       # prévias A/B depois de guardar as opções no app
```

O mix de áudio e o fundo preparado ficam em cache (`.work/`) e só são refeitos quando algo muda.
A fila de renders é salva em `projects/_studio-state/queue.json`; se o app cair durante um render, o vídeo interrompido volta ao começo da fila após reiniciar.

## project.json mínimo

```json
{
  "channel": "exemplo",
  "title": "October Morning Bossa Nova 🍂 Cozy Brazilian Coffee Jazz",
  "background": "background.mp4",
  "tracks": "tracks"
}
```

`background` aceita imagem (png/jpg) ou vídeo curto em loop (mp4) — o vídeo é repetido até o fim da música e o fps de saída segue o do loop. Qualquer campo do
`channel.json` pode ser sobrescrito no `project.json` (ex.: `"visualizer": { "preset": "circle" }`).

## Opções principais

| Campo | O que faz |
|---|---|
| `audio.targetLufs` | volume alvo de cada faixa (YouTube normaliza em -14) |
| `audio.crossfade` | segundos de transição entre faixas; `0` desliga o fade |
| `audio.ambience` | `{ "file": "chuva.mp3", "volumeDb": -22, "enabled": true, "fadeIn": 3, "fadeOut": 3 }` — som ambiente em loop sob a música; fades opcionais (`0` = desligado), também configuráveis na aba Músicas |
| `loopTransition` | `cut` (corte), `crossfade` (dissolver voltas de vídeo) ou `fade-black` (escurecer e reaparecer; funciona com vídeo e imagem) |
| `loopFade` | duração da transição na emenda do loop, em segundos (padrão 0,75) |
| `imageLoopSeconds` | intervalo, em segundos, entre transições `fade-black` quando o fundo é uma imagem |
| `backgroundAnim` | `fade` para começar o vídeo com o fundo aparecendo gradualmente; `none` para entrada imediata |
| `backgroundSmooth` | suaviza a "fervura"/tremor de texturas típica de vídeo de IA (nº de frames, ímpar; padrão 5; 0 desliga) |
| `cleanMetadata` | `true` para gerar o MP4 sem copiar metadados do fundo/áudio e sem capítulos embutidos (também disponível como opção no app; padrão `false`) |
| `backgroundDim` | escurece o fundo inteiro (0–1) |
| `bottomShade` | `{ "strength": 0.65, "height": 420 }` — sombra suave embaixo, para o visualizer aparecer em cenas claras |
| `visualizer.preset` | desenhados (com prévia ao vivo): `capsules` (barras arredondadas), `dots` (pontos empilhados), `silk` (curva translúcida), `mountains` (montanhas preenchidas), `needles` (agulhas com pontos), `ribbon` (quatro linhas de fita), `ring` (barras radiais), `orbit` (pontos em órbita), `halo` (onda circular contínua), `sunburst` (raios com pontos) — via FFmpeg: `bars`, `wave`, `circle` |
| `visualizer.mirror` / `anchor` | graves no centro e agudos nas pontas / `center` (cresce p/ cima e p/ baixo) ou `bottom` |
| `visualizer.attack` / `release` | velocidade de subida/queda das barras (0–1) |
| `visualizer.lineWidth` / `fillAlpha` | espessura das linhas (Seda, Montanhas, Agulhas, Fita) / opacidade do corpo (Seda e Montanhas) |
| `visualizer.color` / `color2` | cor (e gradiente de baixo) |
| `visualizer.width`, `height`, `bottom` | tamanho e distância da borda inferior |
| `visualizer.bars`, `gap` | número de barras e espaço entre elas |
| `visualizer.sensitivity` | altura das barras / amplitude da onda |
| `visualizer.smoothing` | suavidade do movimento (segundos) |
| `visualizer.glow`, `glowStrength`, `reflection`, `opacity` | brilho, reflexo e transparência |
| `visualizer.centerImage`, `radius`, `rotation`, `center` | só no `circle`: capa no centro, raio, graus/s, posição |
| `visualizer.enabled` | `false` para vídeo sem visualizer |
| `text.nowPlaying` | nome da faixa atual com fade (fonte, tamanho, cor, posição x/y do drawtext) |
| `text.trackProgress` | nome da faixa com linha e marcador de progresso; `enabled`, `font`, `size`, `color`, `x`, `y`, `width`, `lineGap`, `lineColor`, `dotColor` |
| `text.cta` | aviso de like/comment/subscribe; `enabled`, `text`, `font`, `size`, `color`, `x`, `y`, `anim`, `first`, `every`, `duration` |
| `text.title` | texto fixo na tela (`{title}` = título do vídeo) |
| `description.template` | modelo da descrição; `{title}` e `{tracklist}` são substituídos |

Com `cleanMetadata: true`, o render (inclusive prévia e overlay) descarta tags do arquivo de origem e capítulos internos. O MP4 ainda terá campos técnicos necessários ou criados pelo codificador, como formato, codec e versão do FFmpeg; a descrição e os capítulos gerados em `description.txt` não são alterados.

## Desempenho (RTX 3070)

Render a ~3× tempo real: um vídeo de 1h leva ~20 min. A análise de volume das faixas é feita uma vez e fica em cache.
