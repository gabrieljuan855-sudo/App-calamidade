-- Migração para o D1 de produção já existente (schema.sql sozinho só serve
-- pra banco novo, criado do zero — CREATE TABLE falha se a tabela já existe).
--
-- NÃO precisa ser rodada à mão: o próprio Worker garante esta coluna antes
-- de usar o banco (garantirSchema, em worker.js). Este arquivo fica como
-- registro do que mudou e para quem quiser aplicar manualmente:
--   wrangler d1 execute cadastro-familias-enchente --remote --file d1-piloto/migrations/0001_gps_origem.sql

ALTER TABLE cadastros ADD COLUMN gps_origem TEXT DEFAULT '';
