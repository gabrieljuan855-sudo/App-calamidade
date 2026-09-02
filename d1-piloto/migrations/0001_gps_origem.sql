-- Migração para o D1 de produção já existente (schema.sql sozinho só serve
-- pra banco novo, criado do zero — CREATE TABLE falha se a tabela já existe).
-- Aplicar com:
--   wrangler d1 execute cadastro-familias-enchente --remote --file d1-piloto/migrations/0001_gps_origem.sql

ALTER TABLE cadastros ADD COLUMN gps_origem TEXT DEFAULT '';
