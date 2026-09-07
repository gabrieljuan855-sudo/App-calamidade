-- Schema de produção — Cloudflare D1 no lugar do Google Sheets/Apps Script.
-- Espelha a estrutura de `apps-script/Code.gs`: abas Cadastros/Gestores/
-- Histórico da planilha viram tabelas; PropertiesService (picos) vira tabela;
-- CacheService (freio de força bruta) vira tabela com janela fixa em SQL.

CREATE TABLE gestores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- HMAC-SHA256(pin, PIN_PEPPER) em hexadecimal. Nunca o PIN em texto puro.
  -- O pepper mora só no segredo do Worker — mesmo uma cópia inteira desta
  -- tabela não permite tentar PINs sem ele. Isso é a mudança de segurança
  -- central da migração: hoje (Code.gs/Sheets) o PIN é gravado e comparado
  -- em texto puro, e qualquer master consegue "ver o PIN" de outro acesso.
  pin_lookup TEXT NOT NULL UNIQUE,
  nome TEXT NOT NULL,
  cpf TEXT DEFAULT '',
  papel TEXT NOT NULL CHECK (papel IN ('Profissional', 'Técnico', 'Master')),
  fundador INTEGER NOT NULL DEFAULT 0,
  abrigo TEXT DEFAULT ''
);

-- Colunas 1:1 com HEADERS do Code.gs (linha 17), em snake_case. Os campos
-- abrigo/id_abrigo/pessoas_alimentacao/data_saida_abrigo/obs_abrigo/
-- composicao_etaria são os "administrativos" (ADMIN_COL no Code.gs): só são
-- sobrescritos quando vêm explicitamente no payload de upsert, senão mantêm
-- o valor já salvo.
CREATE TABLE cadastros (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  responsavel TEXT NOT NULL,
  cpf TEXT DEFAULT '',
  endereco TEXT DEFAULT '',
  gps_lat TEXT DEFAULT '',
  gps_lng TEXT DEFAULT '',
  -- Diz de onde veio gps_lat/gps_lng, pro mapa não confundir um ponto
  -- confirmado com um aproximado: 'no_local' (capturado na própria casa),
  -- 'endereco' (geocodificado a partir do endereço digitado) ou 'ajustado'
  -- (corrigido à mão no mapa). Vazio = linha antiga, origem desconhecida.
  gps_origem TEXT DEFAULT '',
  bairro TEXT DEFAULT '',
  integrantes TEXT DEFAULT '',
  nomes_integrantes TEXT DEFAULT '',
  situacao TEXT NOT NULL,
  observacoes TEXT DEFAULT '',
  profissional_nome TEXT DEFAULT '',
  profissional_cpf TEXT DEFAULT '',
  status TEXT DEFAULT '',
  motivo_cancelamento TEXT DEFAULT '',
  abrigo TEXT DEFAULT '',
  id_abrigo TEXT DEFAULT '',
  pessoas_alimentacao TEXT DEFAULT '',
  data_saida_abrigo TEXT DEFAULT '',
  obs_abrigo TEXT DEFAULT '',
  composicao_etaria TEXT DEFAULT '',
  contato TEXT NOT NULL
);
CREATE INDEX idx_cadastros_profissional ON cadastros(profissional_cpf);
CREATE INDEX idx_cadastros_situacao ON cadastros(situacao);
CREATE INDEX idx_cadastros_abrigo ON cadastros(abrigo);

-- Espelha a aba "Histórico" — append-only, uma linha por campo alterado.
-- Nunca é lida de volta por nenhuma action (write-only), igual hoje.
CREATE TABLE historico (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  gestor_nome TEXT NOT NULL,
  familia_id TEXT DEFAULT '',
  familia_nome TEXT DEFAULT '',
  campo TEXT NOT NULL,
  alteracao TEXT NOT NULL
);

-- Acompanhamento vivo de cada família (visitas, ligações, encaminhamentos),
-- separado do cadastro estático em `cadastros` e do log automático em
-- `historico`. Também append-only: um engano se corrige com um novo
-- registro, não com edição do antigo. A pendência "atual" de uma família é
-- o `status` do atendimento mais recente dela.
CREATE TABLE IF NOT EXISTS atendimentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  familia_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  gestor_nome TEXT NOT NULL,
  tipo TEXT NOT NULL,               -- visita | ligacao | encaminhamento | entrega | outro
  observacao TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pendente'  -- pendente | resolvido
);
CREATE INDEX IF NOT EXISTS idx_atendimentos_familia ON atendimentos(familia_id);

-- Substitui PropertiesService.getScriptProperties() do Code.gs. Chaves:
-- 'peak_total' e 'peak_abrigo_<indice>' (mesmo índice de ABRIGOS no worker).
CREATE TABLE picos (
  chave TEXT PRIMARY KEY,
  valor INTEGER NOT NULL DEFAULT 0
);

-- Freio de força bruta por PIN — janela fixa de 60s, mesma lógica do
-- Code.gs (CacheService), agora em tabela em vez de cache.
CREATE TABLE auth_falhas (
  pin_lookup TEXT PRIMARY KEY,
  contagem INTEGER NOT NULL,
  inicio_janela INTEGER NOT NULL
);
