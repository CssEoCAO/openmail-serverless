/**
 * Provedores de e-mail gratuito: cada endereço é uma pessoa diferente, então uma
 * regra de domínio derruba cliente de verdade. `gmail.com` ficou bloqueado inteiro
 * de 01 a 08/10/2026 (a rotina promoveu dois endereços a domínio) e oito clientes
 * escreveram para o suporte sem ninguém ver.
 *
 * Sem dependência: o Worker recusa a regra (blocklist-router) e a tela nem oferece
 * "bloquear o domínio" (PersonDetail) com a mesma lista.
 */
const DOMINIOS_GRATUITOS = new Set([
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "hotmail.com.br",
  "outlook.com",
  "outlook.com.br",
  "live.com",
  "live.com.br",
  "msn.com",
  "yahoo.com",
  "yahoo.com.br",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "uol.com.br",
  "bol.com.br",
  "terra.com.br",
  "ig.com.br",
  "globo.com",
  "globomail.com",
  "r7.com",
  "zipmail.com.br",
  "gmx.com",
  "gmx.net",
  "gmx.us",
  "gmx.de",
  "mail.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "zoho.com",
  "yandex.com",
  "yandex.ru",
  "tutanota.com",
  "tuta.io",
  "fastmail.com",
  "hey.com",
  "qq.com",
  "163.com",
  "126.com",
]);

export function ehDominioGratuito(dominio: string): boolean {
  return DOMINIOS_GRATUITOS.has(dominio.trim().toLowerCase());
}
