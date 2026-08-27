-- Piloto D1 — versão enxuta, só o essencial para o teste local.
-- Não é o esquema completo de produção (faltam abrigos, composição etária,
-- histórico etc.) — isso entra numa migração de verdade, não neste piloto.

CREATE TABLE gestores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- HMAC-SHA256(pin, PIN_PEPPER) em hexadecimal. Nunca o PIN em texto puro.
  -- O pepper mora só no segredo do Worker — mesmo uma cópia inteira desta
  -- tabela não permite tentar PINs sem ele.
  pin_lookup TEXT NOT NULL UNIQUE,
  nome TEXT NOT NULL,
  cpf TEXT DEFAULT '',
  papel TEXT NOT NULL CHECK (papel IN ('Profissional', 'Técnico', 'Master')),
  fundador INTEGER NOT NULL DEFAULT 0,
  abrigo TEXT DEFAULT ''
);

CREATE TABLE cadastros (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  responsavel TEXT NOT NULL,
  cpf TEXT DEFAULT '',
  contato TEXT NOT NULL,
  situacao TEXT NOT NULL,
  profissional_nome TEXT DEFAULT '',
  profissional_cpf TEXT DEFAULT ''
);
CREATE INDEX idx_cadastros_profissional ON cadastros(profissional_cpf);

-- Freio de força bruta por PIN — mesma lógica (janela fixa de 60s) já
-- corrigida no Code.gs nesta sessão, agora em tabela em vez de CacheService.
CREATE TABLE auth_falhas (
  pin_lookup TEXT PRIMARY KEY,
  contagem INTEGER NOT NULL,
  inicio_janela INTEGER NOT NULL
);
