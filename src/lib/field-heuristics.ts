import type { Template } from "../app/types/unimarc"

/**
 * Interface que define uma heurística de preenchimento automático de campos.
 * Cada heurística contém:
 * - pattern: Expressão regular para identificar o tipo de material
 * - fields: Mapeamento de tags UNIMARC para valores ou funções geradoras
 */
interface FieldHeuristic {
    pattern: RegExp
    fields: Record<string, string | ((match: RegExpMatchArray, description: string) => string)>
}

/**
 * Conjunto de heurísticas para diferentes tipos de materiais culturais.
 * Ordem de avaliação é importante - a primeira correspondência será aplicada.
 */
const MATERIAL_HEURISTICS: FieldHeuristic[] = [
    // Heurística para materiais musicais (CDs, álbuns)
    {
        pattern: /cd|disco|álbum|album|música|music/i,
        fields: {
            "300": "1 disco sonoro",        // Descrição física padrão
            "337": "audio",     // Tipo de conteúdo
            "338": "disco",     // Tipo de suporte
            "020": "", // ISBN intencionalmente vazio para CDs
        },
    },
    // Heurística para materiais textuais (livros, publicações)
    {
        pattern: /livro|book|romance|ensaio|manual/i,
        fields: {
            // Função dinâmica para número de páginas
            "300": (match, desc) => {
                const pages = desc.match(/(\d+)\s*p[áa]g/i)
                return pages ? `${pages[1]} p.` : "p."
            },
            "337": "texto",     // Tipo de conteúdo
            "338": "volume",        // Tipo de suporte
        },
    },
    // Heurística para materiais audiovisuais (DVDs, filmes)
    {
        pattern: /dvd|filme|movie|cinema/i,
        fields: {
            "300": "1 disco óptico",        // Descrição física padrão
            "337": "vídeo",     // Tipo de conteúdo
            "338": "disco",     // Tipo de suporte
        },
    },
]

/**
 * Padrões para extração de títulos de descrições textuais.
 * Ordenados por probabilidade de acerto - avaliação é feita em ordem.
 */
const TITLE_PATTERNS = [
    /["'](.*?)["']/, // Entre aspas
    /«(.*?)»/, // Entre aspas portuguesas
    /(.*?)\s+d[eo]s?\s+/i, // Antes de "dos/das/de"
    /^([^,]+)/, // Primeira parte antes da vírgula
]

/**
 * Padrões para extração de autores de descrições textuais.
 * Ordenados por probabilidade de acerto.
 */
const AUTHOR_PATTERNS = [
    /d[eo]s?\s+([^,]+)/i, // Depois de "dos/das/de"
    /por\s+([^,]+)/i, // Depois de "por"
    /autor[:\s]+([^,]+)/i, // Depois de "autor:"
]

/**
 * Classe responsável pela inferência automática de campos UNIMARC.
 * Implementa:
 * - Identificação de tipo de material
 * - Extração estruturada de metadados
 * - Geração de campos de controle
 * - Validação de preenchibilidade automática
 */
export class FieldInferenceEngine {
    /**
     * Infere campos UNIMARC com base na descrição textual e template.
     * 
     * Fluxo de processamento:
     * 1. Aplica heurísticas de tipo de material
     * 2. Extrai título (campo 245)
     * 3. Extrai autor (campo 100)
     * 4. Extrai ano de publicação (campo 260/264)
     * 
     * @param description Descrição textual do item
     * @param template Template UNIMARC sendo utilizado
     * @returns Objeto com campos inferidos { [tag]: valor }
     */
    inferFields(description: string, template: Template): Record<string, string> {
        const inferred: Record<string, string> = {}

        // 1. Aplica heurísticas de tipo de material (livro, CD, DVD, etc.)
        for (const heuristic of MATERIAL_HEURISTICS) {
            if (heuristic.pattern.test(description)) {
                for (const [field, value] of Object.entries(heuristic.fields)) {
                    // Garante que o campo existe no template atual
                    if (this.templateHasField(template, field)) {
                        inferred[field] =
                            typeof value === "function" ? value(description.match(heuristic.pattern)!, description) : value
                    }
                }
                break // Só aplica a primeira heurística que tiver correspondência
            }
        }

        // 2. Tenta extrair o título (campo 245)
        if (this.templateHasField(template, "245")) {
            const title = this.extractTitle(description)
            if (title) inferred["245"] = title
        }

        // 3. Tenta extrair o autor (campo 100)
        if (this.templateHasField(template, "100")) {
            const author = this.extractAuthor(description)
            if (author) inferred["100"] = author
        }

        // 4. Extrai o ano de publicação (campo 260 ou 264)
        const year = this.extractYear(description)
        if (year) {
            if (this.templateHasField(template, "264")) {
                inferred["264"] = year
            } else if (this.templateHasField(template, "260")) {
                inferred["260"] = year
            }
        }

        return inferred
    }

    /**
     * Verifica se o template contém um determinado campo (tag)
     */
    private templateHasField(template: Template, tag: string): boolean {
        return [...template.controlFields, ...template.dataFields].some((field) => field.tag === tag)
    }

    /**
     * Tenta extrair o título da descrição usando padrões definidos
     */
    private extractTitle(description: string): string | null {
        for (const pattern of TITLE_PATTERNS) {
            const match = description.match(pattern)
            if (match && match[1]?.trim()) {
                return match[1].trim()
            }
        }
        return null
    }

    /**
     * Tenta extrair o autor da descrição usando padrões definidos
     */
    private extractAuthor(description: string): string | null {
        for (const pattern of AUTHOR_PATTERNS) {
            const match = description.match(pattern)
            if (match && match[1]?.trim()) {
                return match[1].trim()
            }
        }
        return null
    }

    /**
     * Extrai o ano da descrição (apenas anos entre 1900 e 2099)
     */
    private extractYear(description: string): string | null {
        const yearMatch = description.match(/\b(19|20)\d{2}\b/)
        return yearMatch ? yearMatch[0] : null
    }

    /**
     * Retorna todos os campos (controlFields + dataFields) existentes num template
     */
    getAllTemplateFields(template: Template): string[] {
        const allFields = new Set<string>()

        // Adiciona TODOS os campos de controle
        template.controlFields.forEach((field) => {
            allFields.add(field.tag)
        })

        // Adiciona TODOS os campos de dados
        template.dataFields.forEach((field) => {
            allFields.add(field.tag)
        })

        // Ordena os campos numericamente
        return Array.from(allFields).sort((a, b) => {
            const numA = Number.parseInt(a)
            const numB = Number.parseInt(b)
            return numA - numB
        })
    }

    /**
     * Gera valores padrão para campos de controle
     */
    generateControlFieldValue(tag: string, description: string): string {
        switch (tag) {
            case "001":
                // Número de controle único
                return `UNIMARC${Date.now()}`

            case "003":
                // Identificador da agência
                return "PT-CATALOG"

            case "005":
                // Data e hora da última transação (YYYYMMDDHHMMSS.F)
                return new Date().toISOString().replace(/[-:T]/g, "").substring(0, 14) + ".0"

            case "008":
                // Elementos de dados de extensão fixa (40 caracteres)
                const currentYear = new Date().getFullYear().toString()
                const year2digit = currentYear.substring(2)
                // Formato: YYMMDD + s + YYYY + 4 espaços + país + 12 espaços + idioma + d
                return `${year2digit}0101s${currentYear}    pt            000 0 por d`

            case "040":
                // Fonte da catalogação
                return "PT-CATALOG"

            case "041":
                // Código de idioma
                return "por"

            default:
                return ""
        }
    }

    /**
     * Verifica se um campo pode ser preenchido automaticamente
     */
    canAutoFill(tag: string): boolean {
        // Campos de controle que podem ser gerados automaticamente
        const autoControlFields = ["001", "003", "005", "008", "040", "041"]

        // Campos de dados que podem ser extraídos da descrição
        const autoDataFields = ["100", "245", "260", "264", "300", "337", "338"]

        return autoControlFields.includes(tag) || autoDataFields.includes(tag)
    }
}

export const fieldInference = new FieldInferenceEngine()