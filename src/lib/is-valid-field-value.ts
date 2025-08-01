// lib/utils/is-valid-field-value.ts
export function isValidFieldValue(value: any, fieldDef?: any): boolean {
    if (value === undefined || value === null) return false
    if (typeof value === "string") {
        const trimmed = value.trim()
        if (trimmed.length === 0) return false
        // Valores que indicam "não se aplica" ou vazio
        if (["n/a", "não se aplica", "não", "nao", "-", "none", "null"].includes(trimmed.toLowerCase())) {
            // Se o campo for obrigatório, estes valores são considerados inválidos para preenchimento.
            // Se for opcional, podem ser aceites como "vazio" ou "não aplicável".
            // A lógica da API route decidirá se deve perguntar novamente ou armazenar como null.
            // Aqui, retornamos false para indicar que não é um valor "válido" para ser armazenado.
            return fieldDef?.mandatory ? false : false // Sempre false para estes valores, a API decide o que fazer
        }
        return true
    }
    if (Array.isArray(value)) {
        // Se for um array, é válido se pelo menos um item for válido
        return value.some((item) => isValidFieldValue(item, fieldDef))
    }
    if (typeof value === "object") {
        // Se for um objeto (ex: subcampos), é válido se pelo menos um valor de subcampo for válido
        return Object.values(value).some((v) => isValidFieldValue(v, fieldDef))
    }
    return false
}