# Mapa das famílias

Este documento guarda o plano do mapa que mostra onde moram as famílias
atingidas. **Implementado** — as seções 1, 2 e 3 abaixo (modelo de dados,
captura da casa e a tela do mapa) estão no código, no ícone de alfinete da
barra inferior, para Técnico e Master. A seção 4 (círculos de concentração no
painel público) segue como estava planejada: ainda não implementada — só faz
sentido depois que houver coordenadas suficientes gravadas.

Documento mantido como referência de desenho e das decisões tomadas.

## O impedimento real (e um erro que já acontece hoje)

O trabalho não é desenhar o mapa. É que o app **não guarda onde a família
mora**. Ele guarda "onde o celular estava na hora do cadastro", que é outra
coisa — e nem sempre é a casa.

Hoje o botão **"Usar localização atual"** (`index.html`, ~linha 2027) faz duas
coisas de uma vez:

1. grava as coordenadas do aparelho em `gpsLat`/`gpsLng`;
2. busca o endereço daquele ponto no Nominatim e **sobrescreve** rua, número
   e bairro com o que voltou.

Isso embute a suposição de que quem cadastra está na porta da casa. Só que o
cadastro muitas vezes é feito no abrigo, depois que a família já foi acolhida.
Nesse caso o resultado é errado duas vezes: o pino cairia no abrigo, e **o
endereço digitado da família é substituído pelo endereço do abrigo**, sem
avisar ninguém.

Vale registrar: esse segundo problema é uma perda de dado que **já existe
hoje**, independente de mapa. É o motivo pelo qual o trabalho começa por
separar os dois conceitos, e não por instalar uma biblioteca de mapa.

## Ordem do trabalho

1. Guardar a localização da casa como dado próprio, com a origem registrada.
2. Descobrir essa coordenada a partir do endereço, quando ninguém esteve na casa.
3. Só então desenhar o mapa.

## Decisões já tomadas

- A casa é localizada **pelo endereço digitado, com ajuste manual no mapa**
  quando o automático errar ou não achar.
- O mapa com os pinos das casas fica **dentro do app, atrás de PIN**, para
  **Técnico e Master**. Endereço de família em situação de vulnerabilidade não
  vai para página aberta.
- O painel público (`acompanhamento.html`, que qualquer pessoa com o link vê,
  sem PIN) mostra **concentração por região, sem pino individual**.

## 1. Modelo de dados

Uma coluna nova em `cadastros` (`d1-piloto/schema.sql`):

```sql
ALTER TABLE cadastros ADD COLUMN gps_origem TEXT DEFAULT '';
```

`gps_lat`/`gps_lng` passam a significar **a casa da família** — é o que o mapa
mostra. `gps_origem` diz de onde veio o ponto, e é o que impede o mapa de
mentir: sem isso, um pino que na verdade é o abrigo fica visualmente idêntico
a um pino que é mesmo a casa.

| valor       | significado                                        |
|-------------|----------------------------------------------------|
| `no_local`  | capturado com o aparelho na casa da família (confiável) |
| `endereco`  | obtido do endereço digitado (aproximado)           |
| `ajustado`  | posicionado/corrigido à mão no mapa (confiável)    |
| `''`        | linhas antigas, origem desconhecida — o mapa marca como tal |

O mapeamento campo → coluna → rótulo é 1:1 hoje e precisa continuar assim.
Pontos a alterar:

- `d1-piloto/schema.sql` — a coluna
- `d1-piloto/worker.js` — `COLUNAS_CADASTRO` (par
  `['gps_origem', 'Origem da localização']`) e `novaLinha`, no `upsert`
- `cadastro-familias-enchente-pwa/index.html` — `mapRemoteRowToRecord`,
  `buildUpsertFromOriginal` e o registro criado no submit do formulário

### Regra de proteção no `upsert`

Para `gps_lat`, `gps_lng` e `gps_origem`: **valor vazio nunca sobrescreve
valor já gravado**. Nenhuma tela oferece "apagar a localização", então a regra
não tira nada de ninguém — e fecha o buraco em que um cadastro antigo, criado
offline e ainda não atualizado, reenvia `gpsLat: ''` e apaga a coordenada que
o mapa acabou de descobrir. É a mesma classe de problema que o `adminValue` já
resolve para os campos de abrigo.

## 2. Captura da casa

**O botão de GPS passa a ser explícito.** Trocar "Usar localização atual" por
**"Estou na casa desta família"**. Assim ele deixa de ser usado por engano no
abrigo. Quando é verdade, o comportamento atual está certo e continua:
grava a coordenada e preenche o endereço — agora também gravando
`gps_origem = 'no_local'`.

**Quando o cadastro é feito em outro lugar**, o profissional só digita o
endereço, como já faz. A coordenada é descoberta depois, geocodificando
`rua, número, bairro, Taquara, RS` no mesmo Nominatim que o app já usa —
nenhum serviço novo.

**Onde a geocodificação roda:** na tela do mapa, não no cadastro. O cadastro é
offline-first e não pode depender de rede; já quem abre o mapa está online por
definição (o mapa precisa dos tiles). Ao abrir, a tela procura os cadastros com
endereço e sem coordenada, geocodifica **um por vez, com 1 segundo de
intervalo** (a política do Nominatim pede no máximo 1 requisição por segundo) e
mostra o progresso: "3 casas ainda sem localização — localizando…". O resultado
é gravado no banco, então isso acontece **uma vez para toda a equipe**, não uma
vez por aparelho.

**Ajuste manual:** tocar num pino abre a família; um botão "Corrigir local da
casa" deixa arrastar o pino e salvar, gravando `gps_origem = 'ajustado'`.
Atende também o caso de rua sem número mapeado no OpenStreetMap, em que o
geocoder devolve o meio da rua.

### Ação nova no Worker: `definirLocalCasa`

Assinatura `{ id, lat, lng, origem }` — em vez de reaproveitar o `upsert`.

O motivo é concreto: o `upsert` reescreve a linha inteira, e mandar uma linha
parcial apaga os campos ausentes. Uma ação que grava só as três colunas de
localização não tem como danificar nome, endereço ou dados de abrigo.
Autenticada, com o mesmo escopo por abrigo que o `upsert` já aplica ao
Técnico, e registrando no `historico`.

## 3. Tela do mapa (Técnico e Master)

Painel novo `#mapaPanel`, no mesmo padrão dos existentes (overlay em tela
cheia com classe `.open`):

- botão novo na barra inferior (`#navMapaBtn`), visível conforme
  `updateAdminLinkVisibility` para Técnico e Master — mesma régua da Gestão
  de abrigos;
- incluir `els.mapaPanel` nos dois arrays de `MutationObserver` do
  `index.html`, que já cuidam sozinhos da trava de scroll e do destaque na
  barra inferior;
- dados via `gestorData`, que já filtra por abrigo para o Técnico — ou seja,
  o Técnico vê no mapa as famílias do abrigo dele, coerente com o resto do app.

Renderização com **Leaflet via CDN + tiles do OpenStreetMap**. Será a primeira
dependência JavaScript externa do projeto (hoje não há nenhuma), e o service
worker não guarda recursos de outra origem — então **a tela do mapa exige
internet**. É aceitável para uma ferramenta de coordenação, e o cadastro
continua funcionando offline como hoje.

Pinos coloridos por situação (as mesmas cores dos chips), com a origem visível
na legenda: um pino aproximado não pode parecer confirmado.

## 4. Painel público — concentração sem endereço (segunda etapa)

O GET público continua **sem devolver nenhuma coordenada individual**. Em vez
disso, devolve células agregadas: as coordenadas das casas são arredondadas
para 2 casas decimais (≈ 1 km) e agrupadas, virando
`mapaAgregado: [{ lat, lng, familias }]`.

Assim, uma célula com uma única família revela um quadrado de ~1 km, não uma
casa. Não precisa de tabela nova nem de geocodificar bairro.

Só faz sentido depois que a etapa 1 já tiver gravado coordenadas suficientes.

## Fora de escopo

- Guardar *onde o cadastro foi feito* (para o mapa, só a casa importa)
- Mapa offline / tiles embarcados
- Abrigos com coordenada própria (a lista segue fixa no código)

## Como verificar quando for implementado

- **Mapeamento campo → coluna → rótulo** nas três camadas (schema, Worker,
  app): conferir que `gps_origem` não ficou faltando em nenhum dos pontos
  listados na seção 1. Um cadastro salvo pela tela real precisa chegar com
  todos os campos nas colunas certas.
- **Worker local de verdade** (`wrangler dev --local` + D1 local com o schema):
  `definirLocalCasa` grava as três colunas e não toca em nenhuma outra;
  Técnico é barrado em cadastro de outro abrigo; valor vazio não apaga
  coordenada existente; `historico` registra a mudança.
- **Privacidade (teste obrigatório):** afirmar que a resposta do GET público
  não contém `Latitude`, `Longitude` nem nenhum dado por família — só as
  células agregadas.
- **Ponta a ponta com o app real** contra o Worker local: cadastrar sem GPS,
  informando só o endereço → abrir o mapa como Master → a casa é localizada e
  o pino aparece → arrastar o pino → reabrir e confirmar que ficou `ajustado`
  na posição nova.
- Conferir que **o cadastro continua funcionando offline** — a tela de cadastro
  não pode passar a depender do Leaflet nem do Nominatim.
- Atualizar `docs/manual.html`: a tela nova e, principalmente, o novo
  significado do botão de GPS.
- Bump de `APP_BUILD` e `CACHE_NAME`, e o `ALTER TABLE` aplicado no D1 de
  produção **antes** de publicar o front.
