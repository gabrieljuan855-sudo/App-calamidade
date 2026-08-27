# Piloto D1 — prova de conceito

Isso **não é o app em produção**. É um teste isolado, local, para provar que
Cloudflare D1 (SQLite na borda) funciona como substituto do Google Sheets antes
de decidir migrar de verdade. Nada aqui está publicado nem conectado ao site real.

## O que existe aqui

- `schema.sql` — duas tabelas essenciais (`gestores`, `cadastros`) e o freio de
  força bruta (`auth_falhas`). Não é o esquema completo de produção — falta
  abrigos, composição etária, histórico etc. (isso é escopo da migração real).
- `worker.js` — backend mínimo: login, cadastrar família, listar/criar acessos,
  redefinir PIN.
- `index.teste.html` — cópia do `index.html` de produção, só com o `SYNC_URL`
  apontando para o Worker local e a tela "Gerenciar acessos" adaptada ao novo
  modelo de PIN (só redefinir, nunca ver).
- `wrangler.toml` — projeto separado, com seu próprio banco D1.

## A mudança de segurança que este piloto testa

PIN de **6 dígitos**, nunca gravado em texto puro. O banco guarda só:

```
pin_lookup = HMAC-SHA256(pin, PIN_PEPPER)
```

`PIN_PEPPER` é um segredo do servidor, nunca fica no banco. Sem ele, uma cópia
inteira da tabela `gestores` não permite tentar PINs. E como o HMAC não tem
volta, **"ver o PIN de alguém" deixou de ser possível por construção** — o
"Gerenciar acessos" agora só tem "Redefinir PIN", que mostra o novo PIN uma
única vez, na hora.

## Como rodar você mesmo (opcional — tudo local, não pede login na Cloudflare)

```bash
cd d1-piloto
npx wrangler d1 execute d1-piloto --local --file schema.sql

# Semeia o primeiro acesso Master (PIN 123456, só para teste):
LOOKUP=$(node -e "console.log(require('crypto').createHmac('sha256','pepper-de-teste-local-nao-usar-em-producao').update('123456').digest('hex'))")
npx wrangler d1 execute d1-piloto --local --command \
  "INSERT INTO gestores (pin_lookup, nome, papel, fundador) VALUES ('$LOOKUP', 'Seu Nome', 'Master', 1);"

npx wrangler dev --local --port 8787 --var PIN_PEPPER:pepper-de-teste-local-nao-usar-em-producao
# Em outro terminal:
python3 -m http.server 8098
# Abra http://localhost:8098/index.teste.html e entre com o PIN 123456
```

## O que foi provado (relatório completo na conversa)

1. Login com PIN de 6 dígitos.
2. Cadastro de família gravado no D1.
3. Criar acesso: PIN aparece uma vez, `listGestores` nunca mais devolve o PIN.
4. Redefinir PIN: o antigo para de funcionar, o novo passa a funcionar.
5. PIN fora do padrão de 6 dígitos é recusado.
6. Conferência direta no banco: só existe hash, nunca PIN em texto puro.

Tudo isso rodado de ponta a ponta com Playwright, contra o `index.teste.html`
real (não é só teste de API) — 12 verificações, todas passando.

## O que este piloto **não** cobre

Não é a migração completa. Faltam: abrigos, composição etária/relatórios,
arquivar evento, remover acesso, editar nome/papel de um acesso existente, e
principalmente a **migração dos dados reais** da planilha atual. Também não
inclui uma comparação de velocidade cronometrada contra o Apps Script real —
este ambiente de teste não alcança `script.google.com`.
