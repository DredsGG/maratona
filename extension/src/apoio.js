// Maratona — dados e código Pix do "Apoiar ♥" (regra 16 do hub). Sem rede: o BR Code e o QR são gerados aqui.
// Dados oficiais: Jarvis/02-projetos/extensoes/apoio.md (não inventar; mudou lá, muda aqui).
// BR Code estático: 00 01 · 26 (00 br.gov.bcb.pix, 01 chave) · 52 0000 · 53 986 · 54 valor (opcional) · 58 BR · 59 nome ·
// 60 cidade · 62 (05 ***) · 63 CRC16-CCITT-FALSE (poly 0x1021, início 0xFFFF) sobre tudo até "6304", hex maiúsculo de 4 dígitos.
(() => {
  const DADOS = {
    sponsors: 'https://github.com/sponsors/DredsGG',
    chave: 'fa525dad-afca-4683-845d-eee7225a53e3',
    nome: 'Andre Miller Fleck',
    cidade: 'Sao Paulo',
    valores: [5, 10, 25],
  };
  const tlv = (id, v) => id + String(v.length).padStart(2, '0') + v;
  function crc16(s) {
    let crc = 0xffff;
    for (let i = 0; i < s.length; i++) {
      crc ^= s.charCodeAt(i) << 8;
      for (let b = 0; b < 8; b++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
  }
  // valor em reais (número) ou null para "valor livre"
  function brcode(valor) {
    let s = tlv('00', '01') + tlv('26', tlv('00', 'br.gov.bcb.pix') + tlv('01', DADOS.chave)) + tlv('52', '0000') + tlv('53', '986');
    if (valor != null) s += tlv('54', Number(valor).toFixed(2));
    s += tlv('58', 'BR') + tlv('59', DADOS.nome) + tlv('60', DADOS.cidade) + tlv('62', tlv('05', '***')) + '6304';
    return s + crc16(s);
  }
  // "12,50" / "12.5" / "R$ 7" → 12.5 ; "" → null (livre) ; fora de R$ 1 a R$ 10.000 ou inválido → NaN
  function lerValor(txt) {
    const t = String(txt == null ? '' : txt).replace(/r\$|\s/gi, '');
    if (!t) return null;
    if (!/^\d{1,5}([.,]\d{1,2})?$/.test(t)) return NaN;
    const v = Math.round(parseFloat(t.replace(',', '.')) * 100) / 100;
    return v >= 1 && v <= 10000 ? v : NaN;
  }
  const api = { DADOS, crc16, brcode, lerValor };
  globalThis.MT_APOIO = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})();
