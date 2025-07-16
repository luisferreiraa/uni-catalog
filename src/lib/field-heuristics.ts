import type { Template } from "../app/types/unimarc"

interface FieldHeuristic {
    pattern: RegExp
    fields: Record<string, string | ((match: RegExpMatchArray, description: string) => string)>
}

// Heurísticas otimizadas para diferentes tipos de material
const MATERIAL_HEURISTICS: FieldHeuristic[] = [
    // CDs e música
    {
        pattern: /cd|disco|álbum|album|música|music/i,
        fields: {
            "300": "1 disco sonoro",
            "337": "audio",
            "338": "disco",
            "020": "", // ISBN vazio para CDs
        },
    },
    // Livros
    {
        pattern: /livro|book|romance|ensaio|manual/i,
        fields: {
            "300": (match, desc) => {
                const pages = desc.match(/(\d+)\s*p[áa]g/i)
                return pages ? `${pages[1]} p.` : "p."
            },
            "337": "texto",
            "338": "volume",
        },
    },
    // DVDs e filmes
    {
        pattern: /dvd|filme|movie|cinema/i,
        fields: {
            "300": "1 disco óptico",
            "337": "vídeo",
            "338": "disco",
        },
    },
]

// Extração de títulos otimizada
const TITLE_PATTERNS = [
    /["'](.*?)["']/, // Entre aspas
    /«(.*?)»/, // Entre aspas portuguesas
    /(.*?)\s+d[eo]s?\s+/i, // Antes de "dos/das/de"
    /^([^,]+)/, // Primeira parte antes da vírgula
]

// Extração de autores
const AUTHOR_PATTERNS = [
    /d[eo]s?\s+([^,]+)/i, // Depois de "dos/das/de"
    /por\s+([^,]+)/i, // Depois de "por"
    /autor[:\s]+([^,]+)/i, // Depois de "autor:"
]

export class FieldInferenceEngine {
    /**
     * Infere campos automaticamente baseado na descrição
     */
    inferFields(description: string, template: Template): Record<string, string> {
        const inferred: Record<string, string> = {}

        // Aplica heurísticas de material
        for (const heuristic of MATERIAL_HEURISTICS) {
            if (heuristic.pattern.test(description)) {
                for (const [field, value] of Object.entries(heuristic.fields)) {
                    if (this.templateHasField(template, field)) {
                        inferred[field] =
                            typeof value === "function" ? value(description.match(heuristic.pattern)!, description) : value
                    }
                }
                break // Usa apenas a primeira heurística que match
            }
        }

        // Extrai título (campo 245)
        if (this.templateHasField(template, "245")) {
            const title = this.extractTitle(description)
            if (title) inferred["245"] = title
        }

        // Extrai autor (campo 100)
        if (this.templateHasField(template, "100")) {
            const author = this.extractAuthor(description)
            if (author) inferred["100"] = author
        }

        // Extrai ano (campo 260 ou 264)
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

    private templateHasField(template: Template, tag: string): boolean {
        return [...template.controlFields, ...template.dataFields].some((field) => field.tag === tag)
    }

    private extractTitle(description: string): string | null {
        for (const pattern of TITLE_PATTERNS) {
            const match = description.match(pattern)
            if (match && match[1]?.trim()) {
                return match[1].trim()
            }
        }
        return null
    }

    private extractAuthor(description: string): string | null {
        for (const pattern of AUTHOR_PATTERNS) {
            const match = description.match(pattern)
            if (match && match[1]?.trim()) {
                return match[1].trim()
            }
        }
        return null
    }

    private extractYear(description: string): string | null {
        const yearMatch = description.match(/\b(19|20)\d{2}\b/)
        return yearMatch ? yearMatch[0] : null
    }

    /**
     * CORREÇÃO: Retorna TODOS os campos do template (obrigatórios e opcionais)
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