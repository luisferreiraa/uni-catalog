import { FieldType, PersonRole, Prisma } from "@prisma/client"  // Importa tipos e enums gerados pelo Prisma a partir do schema da base de dados
import { prisma } from "./prisma"   // Importa a instância do cliente Prisma, responsável pela comunicação com a base de dados
import type { Template, DataField } from "@/app/types/unimarc"  // Importa tipos TypeScript definidos localmente para Template e DataField
import { JsonValue } from "@prisma/client/runtime/library"  // Tipo do Prisma para representar valores JSON válidos
import OpenAI from "openai" // Importa a SDK da OpenAI para interagir com os modelos de IA

// Inicializar o cliente OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPEN_API_KEY,   // A API Key é obtida de variáveis de ambiente
})

// Interface que define a estrutura dos dados necessários para guardar um registo (record)
export interface SaveRecordData {
    templateId: string      // ID único do template
    templateName: string    // Nome legível do template
    templateDesc?: string   // Descrição opcional do template
    filledFields: Record<string, any>   // Objeto genérico com pares chave-valor para campos já preenchidos
    // Melhoria: tipar meljor este "any" para evitar erros silenciosos
    template: Template      // Objeto template completo
    textUnimarc: string     // Representação textual do registo em formato UNIMARC
    fields: {
        tag: string     // Tag UNIMARC
        value?: string | null       // Valor textual do campo (se aplicável)
        subfields?: JsonValue       // Subcampos em formato JSON
        fieldType: FieldType        // Tipo de campo (enum vindo do Prisma)
        fieldName?: string | null   // Nome legível do campo
        subfieldNames?: JsonValue   // Nomes legíveis dos subcampos (JSON)
        isRepeatable?: boolean      // Se o campo pode aparecer mais do que uma vez  
    }[]     // Array de campos, cada um representa uma entrada UNIMARC com metadados associados
}

export class DatabaseService {

    /**
     * Função privada para inferir o PersonRole (enum) com base
     * num tag e nome do campo UNIMARC, utilizando o modelo da OpenAI
     * @param fieldTag 
     * @param fieldName 
     * @returns 
     */
    private async inferPersonRole(fieldTag: string, fieldName: string | null): Promise<PersonRole> {

        // Prompt enviado ao modelo da OpenAI
        // Inclui a tag e o nome do campo, e pede explicitamente para
        // retornar apenas um valor específico entre as opções pré-definidas
        const prompt = `Given the UNIMARC field tag "${fieldTag}" and its name "${fieldName || "N/A"}",
        what is the most appropriate role for a person associated with this field?
        Choose one from the following roles: AUTHOR, TRANSLATOR, COMPOSER, INTERPRETER, ILLUSTRATOR, EDITOR, OTHER.
        Return only the role name, e.g., "AUTHOR".`

        try {
            // Chamada à API da OpenAI para criar uma conclusão de chat
            const completion = await openai.chat.completions.create({
                model: "gpt-4o",    // Modelo escolhido para inferência
                messages: [
                    // Contexto do sistema - define o comportamento esperado do modelo
                    { role: "system", content: "You are a helpful assistant that infers person roles from UNIMARC fields." },
                    // Mensagem do utilizador com prompt real
                    { role: "user", content: prompt },
                ],
                temperature: 0.1,   // Baixa temperatira = respostas mais determínisticas e consistentes
                max_tokens: 20,     // Limita o tamanho da resposta, prevenindo texto extra indesejado
            })

            // Extrai o conteúdo da primeira escolha e normaliza para uppercase
            // O uso de optional chaining (`?.`) evita erros caso algum nível seja undefined
            const inferredRole = completion.choices[0]?.message?.content?.trim().toUpperCase() || ""

            // Valida se o valor retornado pela OpenAI corresponde a um valor válido no enum PersonRole
            if (Object.values(PersonRole).includes(inferredRole as PersonRole)) {
                return inferredRole as PersonRole
            } else {
                // Caso a IA devolva algo inválido, avisa na consola e devolve "OTHER"
                console.warn(`OpenAI returned an invalid role: ${inferredRole} for tag ${fieldTag}. Defaulting to OTHER.`)
                return PersonRole.OTHER
            }
            // Tratamento de erros - se a API falhar, regista na consola e devolve "OTHER"
        } catch (error) {
            console.error(`Error inferring person role for tag ${fieldTag}:`, error)
            return PersonRole.OTHER
        }
    }

    /**
     * Verifica se um registo já exise na base de dados baseado em campos únicos
     * A lógica adapta-se ao tipo de template/ material
     */

    private async checkDuplicateRecord(
        fields: SaveRecordData["fields"],   // Campos preenchidos do registo, extraídos da estrutura SaveRecordData
        templateName: string,       // Nome do template/material, usado para escolher a estratégia
    ): Promise<{ isDuplicate: boolean; existingRecord?: any }> {
        try {
            // Log inicial para debug
            console.log(`=== CHECKING DUPLICATES FOR TEMPLATE: ${templateName} ===`)

            // Seleciona a(s) estratégia(s) de detecção de duplicados
            // com base no tipo de template/material
            const duplicateStrategies = this.getDuplicateStrategies(templateName.toLowerCase())

            // Logs para inspeção de estratégias selecionadas
            console.log(`Template: ${templateName}`)
            console.log(`Strategies: ${duplicateStrategies.map((s) => s.name).join(", ")}`)

            // Extrair os valores dos campos relevantes para verificação de duplicados
            // A extração é isolada em "extractFieldValues" para manter o método principal limpo
            const fieldValues = this.extractFieldValues(fields)
            console.log(`Extracted field values:`, fieldValues)

            // Percorre cada estratégia por ordem de prioridade
            // Se encontrar um duplicado, retorna imediatamente
            for (const strategy of duplicateStrategies) {
                console.log(`\n--- Trying strategy: ${strategy.name} ---`)
                const result = await this.checkDuplicateByStrategy(strategy, fieldValues)

                if (result.isDuplicate) {
                    // Encontrou um duplicado - retorna o resultado com o registo existente
                    console.log(`✅ DUPLICATE FOUND using strategy: ${strategy.name}`)
                    return result
                } else {
                    // Nenhum duplicado encontrado nesta estratégia - continua a procurar
                    console.log(`❌ No duplicate found with strategy: ${strategy.name}`)
                }
            }

            // Se nenhuma estratégia encontrou um duplicado, retorna false
            console.log(`=== NO DUPLICATES FOUND FOR ANY STRATEGY ===`)
            return { isDuplicate: false }
        } catch (error) {
            // Tratamento de erro - garante que falhas na verificação de duplicados 
            // não bloqueiam a gravação do registo
            console.error("Erro ao verificar duplicados:", error)
            // Em caso de erro, não bloquear a gravação
            return { isDuplicate: false }
        }
    }

    /**
     * Define estratégias de verificação de duplicados por tipo de material
     * Esta função retorna uma lista de objetos que descrevem quais campos/subcampos
     * devem ser usados para identificar potenciais duplicados, bem como a prioridade de cada estratégia
     */

    private getDuplicateStrategies(templateName: string) {
        const strategies = []   // Lista onde serão acumuladas as estratégias

        switch (templateName) {
            case "book (monograph)":
                strategies.push(
                    // Estratégia 1: ISBN é universalmente único - se coincide, é duplicado
                    { name: "ISBN", fields: ["010"], subfields: ["a"], priority: 1 },

                    // Estratégia 2: Combinação muito específica que reduz falsos positivos
                    {
                        name: "Título+Autor+Ano+Editora",
                        fields: ["200", "700", "210", "210"],   // Tags UNIMARC relevantes
                        subfields: ["a", "a,b", "d", "c"],      // Subcampos relevantes para a comparação
                        priority: 2,
                    },
                    // Estratégia 3: Deteta duplicados com ISBNs parciais + título e autor
                    { name: "Título+Autor+ISBN", fields: ["200", "700", "010"], subfields: ["a", "a,b", "a"], priority: 3 },
                )
                break

            case "periodical publication":
                strategies.push(
                    { name: "ISSN", fields: ["011"], subfields: ["a"], priority: 1 },
                    { name: "Título+Volume+Número", fields: ["200", "207", "207"], subfields: ["a", "a", "b"], priority: 2 },
                    { name: "Key Title", fields: ["530"], subfields: ["a"], priority: 3 },
                )
                break

            case "audio cd":
                strategies.push(
                    { name: "Número Editor", fields: ["071"], subfields: ["a"], priority: 1 },
                    {
                        name: "Título+Responsável+Editora+Ano",
                        fields: ["200", "702", "210", "210"],
                        subfields: ["a", "a,b", "c", "d"],
                        priority: 2,
                    },
                )
                break

            case "dvd (video)":
                strategies.push(
                    { name: "Número Editor", fields: ["071"], subfields: ["a"], priority: 1 },
                    {
                        name: "Título+Diretor+Ano+Editora",
                        fields: ["200", "700", "210", "210"],
                        subfields: ["a", "a,b", "d", "c"],
                        priority: 2,
                    },
                )
                break

            default:
                // Estratégia genérica usada quando o tipo de material não é reconhecido
                // Começa com uma combinação forte e depois tenta ISBN se existir
                strategies.push(
                    {
                        name: "Título+Responsável+Ano+Editora",
                        fields: ["200", "700", "210", "210"],
                        subfields: ["a", "a,b", "d", "c"],
                        priority: 1,
                    },
                    { name: "ISBN", fields: ["010"], subfields: ["a"], priority: 2 },
                )
                break
        }

        // Ordena as estratégias por prioridade antes de devolver
        return strategies.sort((a, b) => a.priority - b.priority)
    }

    /**
   * Verifica se dois registos são realmente duplicados ou apenas edições diferentes
   * 
   * Lógica geral:
   * 1. Se a estratégia for baseada em ISBN e os valores coincidirem, é duplicado
   * 2. Para outras estratégias, compara campos críticos
   * 3. Conta quantas diferenças significativas existem:
   *    - ≥ 2 diferenças → assume edições diferentes
   *    - ≤ 1 diferença → assume que é duplicado.
   */
    private async isDuplicateOrDifferentEdition(
        newRecord: Record<string, any>,
        existingRecord: any,
        strategy: any,
    ): Promise<{ isDuplicate: boolean; reason?: string }> {
        console.log(`\n=== ANALYZING IF RECORDS ARE DUPLICATES OR DIFFERENT EDITIONS ===`)

        // Regra especial: ISBN igual significa duplicado certo
        if (strategy.name === "ISBN") {
            console.log("ISBN match - this is a true duplicate")
            return { isDuplicate: true, reason: "ISBN idêntico" }
        }

        // Lisya para armazenar diferenças encontradas
        const differences = []

        // Comparação campo a campo para outras estratégias

        // Verificar ano de publicação
        const newYear = this.extractYear(newRecord)
        const existingYear = this.extractYear(existingRecord)

        if (newYear && existingYear && newYear !== existingYear) {
            differences.push(`Ano diferente (novo: ${newYear}, existente: ${existingYear})`)
        }

        // Verificar editora
        const newPublisher = this.extractPublisher(newRecord)
        const existingPublisher = this.extractPublisher(existingRecord)

        if (newPublisher && existingPublisher && newPublisher !== existingPublisher) {
            differences.push(`Editora diferente (novo: ${newPublisher}, existente: ${existingPublisher})`)
        }

        // Verificar ISBN (se existir em ambos e forem diferentes)
        const newISBN = this.extractISBN(newRecord)
        const existingISBN = this.extractISBN(existingRecord)

        if (newISBN && existingISBN && newISBN !== existingISBN) {
            differences.push(`ISBN diferente (novo: ${newISBN}, existente: ${existingISBN})`)
        }

        // Verificar edição
        const newEdition = this.extractEdition(newRecord)
        const existingEdition = this.extractEdition(existingRecord)

        if (newEdition && existingEdition && newEdition !== existingEdition) {
            differences.push(`Edição diferente (novo: ${newEdition}, existente: ${existingEdition})`)
        }

        // Log das diferenças encontradas
        console.log(`Differences found: ${differences.length}`)
        differences.forEach((diff) => console.log(`  - ${diff}`))

        // Decisão baseada no número de diferenças
        if (differences.length >= 2) {
            // Muitas diferenças, provavelmente são edições distintas
            console.log("✅ DIFFERENT EDITIONS - allowing new record")
            return {
                isDuplicate: false,
                reason: `Edições diferentes: ${differences.join(", ")}`,
            }
        }

        if (differences.length <= 1) {
            // Poucas diferenças, alta probabilidade de duplicado
            console.log("❌ LIKELY DUPLICATE - blocking new record")
            return {
                isDuplicate: true,
                reason: differences.length === 1 ? `Possível duplicado: ${differences[0]}` : "Registros idênticos",
            }
        }

        // Fallback de segurança (provavelmente nunca chamado)
        return { isDuplicate: false }
    }

    /**
     * Funções auxiliares para extrair campos específicos de um registo UNIMARC
     * Cada função aplica validação e limpeza básiica antes de retornar o valor
     * @param record 
     * @returns 
     */
    private extractYear(record: any): string | null {
        // Campo 210 subcampo d -> ano de publicação
        if (record["210"] && record["210"].d) {
            const year = String(record["210"].d).match(/\d{4}/)
            return year ? year[0] : null
        }
        return null
    }

    private extractPublisher(record: any): string | null {
        // Campo 210 subcampo c -> nome da editora
        if (record["210"] && record["210"].c) {
            return String(record["210"].c).trim()
        }
        return null
    }

    private extractISBN(record: any): string | null {
        // Campo 010 subcampo a -> ISBN (normalizado sem espaços e traços)
        if (record["010"] && record["010"].a) {
            return String(record["010"].a).replace(/[-\s]/g, "").trim()
        }
        return null
    }

    private extractEdition(record: any): string | null {
        // Campo 205 subcampo a -> número/nome da edição
        if (record["205"] && record["205"].a) {
            return String(record["205"].a).trim()
        }
        return null
    }

    /**
     * Extrai valores relevantes de um conjunto de campos para posterior verificação
     * 
     * Contexto:
     * - O sistema trabalha com registos bibliográficos em formato UNIMARC
     * - Cada campo pode ser de dois tipos:
     * 1. DATA -> possui subcampos
     * 2. CONTROL -> possui apenas um valor simples
     * 
     * Função:
     * - Cria um objeto chave-valor (`values`) onde a chave é a tag do campo:
     *      -> Objeto de subcampos (DATA)
     *      -> Valor direto (CONTROL)
     * - Este resultado é usado depois para alimentar estratégias de detecção de duplicados
     */

    private extractFieldValues(fields: SaveRecordData["fields"]): Record<string, any> {
        // Objeto final que mapeia "tag" -> valor ou objeto de subcampos
        const values: Record<string, any> = {}

        // Percorre todos os campos do registo
        for (const field of fields) {

            // Caso 1: Campos de dados (DATA) com subcampos, guarda o objeto de subcampos inteiro
            if (field.fieldType === FieldType.DATA && field.subfields) {
                const subfieldsObj = field.subfields as Record<string, any>
                values[field.tag] = subfieldsObj

                // Caso 2: Campos de controlo (CONTROL) com valores simples -> guarda o valor diretamente
            } else if (field.fieldType === FieldType.CONTROL && field.value) {
                values[field.tag] = field.value
            }

            // Campos que não têm subcampos/valor ou não se enquadram nos tipos acima são ignorados
        }

        // Retorna o objeto com todos os valores organizados por "tag"
        return values
    }

    /**
     * Verifica duplicados utilizando uma estratégia específica de correspondência de campos
     * 
     * Contexto:
     * - O sistema trabalha com registos UNIMARC armazenados na base de dados
     * - A estratégia define quais campos/subcampos devem ser comparados para identificar duplicados
     * - Existem estratégias simples (ex. ISBN) e estratégias compostas (vários campos)
     * 
     * Fluxo geral:
     * 1. Estratégia ISBN - busca direta na base de dados (mais rápido)
     * 2. Outras estratégias - coleta valores relevantes e faz busca por múltiplos campos
     * 3. Filtra resultados para registos que batem exatamente com todos os campos exigidos
     * 4. Passa registros candidatos para `isDuplicateOrDifferentEdition()` para validar se é duplicado ou apenas outra edição.
     */

    private async checkDuplicateByStrategy(
        strategy: any,
        fieldValues: Record<string, any>,
    ): Promise<{ isDuplicate: boolean; existingRecord?: any }> {
        console.log(`Checking strategy: ${strategy.name}`)
        console.log(`Available field values:`, Object.keys(fieldValues))

        // === 1. Estratégia especial: ISBN ===
        // Se a estratégia for ISBN e o registo tiver campo "010" (ISBN), busca por correspondênciia direta na base de dados
        if (strategy.name === "ISBN" && fieldValues["010"]) {
            const isbn = fieldValues["010"].a
            if (isbn) {
                // Limpa ISBN (remove hífens e espaços)
                const cleanISBN = String(isbn).replace(/[-\s]/g, "").trim()

                // Procura na base de dados por registo que tenha subcampo "a" do campo "010" contendo o ISBN limpo
                const existingRecord = await prisma.catalogRecord.findFirst({
                    where: {
                        fields: {
                            some: {
                                tag: "010",
                                subfields: {
                                    path: "$.a",
                                    string_contains: cleanISBN,
                                },
                            },
                        },
                    },
                    include: {
                        fields: {
                            where: {
                                tag: {
                                    in: strategy.fields,    // Carrega só campos relevantes para análise posterior
                                },
                            },
                        },
                    },
                })

                // Se encontrou, retorna como duplicado
                if (existingRecord) {
                    console.log(`ISBN duplicate found: ${cleanISBN}`)
                    return { isDuplicate: true, existingRecord }
                }
            }
        }

        // === 2. Estratégias compostas (múltiplos campos/subcampos) ===
        const extractedValues = []      // Valores extraídos para degug
        const fieldChecks = []

        // Percorre os campos definidos na estratégia
        for (let i = 0; i < strategy.fields.length; i++) {
            const fieldTag = strategy.fields[i]
            const subfieldCodes = strategy.subfields[i].split(",")

            if (!fieldValues[fieldTag]) continue    // Campo não existe no registo atual

            let value = ""

            if (fieldTag.startsWith("0")) {
                // Campo de controle - valor direto
                value = String(fieldValues[fieldTag]).trim()
            } else {
                // Campo de dados - juntar valores dos subcampos definidos
                const subfields = fieldValues[fieldTag]
                const parts = []

                for (const code of subfieldCodes) {
                    if (subfields[code]) {
                        const subfieldValue = Array.isArray(subfields[code])
                            ? String(subfields[code][0]).trim()
                            : String(subfields[code]).trim()
                        parts.push(subfieldValue)
                    }
                }

                // Junta partes, remove vírgulas e limpa os espaços
                value = parts
                    .join(" ")
                    .replace(/,(\s*),/g, ",")
                    .replace(/,$/, "")
                    .trim()
                if (value.endsWith(",")) {
                    value = value.slice(0, -1).trim()
                }
            }

            // Só adiciona se o valor atende ao tamanho mínimo definido na estratégia (se houver)
            if (value && (!strategy.minLength || value.length >= strategy.minLength)) {
                extractedValues.push(value)
                fieldChecks.push({ tag: fieldTag, value, subfieldCodes })
            }
        }

        // Se não encontrou nenhum campo válido para a estratégia, encerra
        if (fieldChecks.length === 0) {
            console.log(`No valid fields found for strategy ${strategy.name}`)
            return { isDuplicate: false }
        }

        // === 3. Busca inicial na base de dados por registos que contenham pelo menos um dos campos definidos  ===
        const allRecords = await prisma.catalogRecord.findMany({
            where: {
                fields: {
                    some: {
                        tag: {
                            in: fieldChecks.map((f) => f.tag),
                        },
                    },
                },
            },
            include: {
                fields: {
                    where: {
                        tag: {
                            in: ["010", "200", "205", "210", "700"], // Campos relevantes para análise detalhada
                        },
                    },
                },
            },
        })

        // === 4. Verificação manual dos registos retornados ===
        for (const record of allRecords) {
            let matchCount = 0

            for (const check of fieldChecks) {
                const recordField = record.fields.find((f) => f.tag === check.tag)

                if (recordField) {
                    if (check.tag.startsWith("0")) {
                        // Comparação direta para campos de controlo
                        if (recordField.value === check.value) {
                            matchCount++
                        }
                    } else {
                        // Comparação campo/subcampo para campos de dados
                        const recordSubfields = recordField.subfields as any
                        if (recordSubfields) {
                            let subfieldMatch = true

                            for (const code of check.subfieldCodes) {
                                const expectedValue = fieldValues[check.tag][code]
                                const recordValue = recordSubfields[code]

                                // Normaliza valores para comparação (remove vírgulas no fim, trim)
                                if (expectedValue && recordValue) {
                                    const cleanExpected = String(expectedValue).replace(/,$/, "").trim()
                                    const cleanRecord = String(recordValue).replace(/,$/, "").trim()

                                    if (cleanExpected !== cleanRecord) {
                                        subfieldMatch = false
                                        break
                                    }
                                } else if (expectedValue || recordValue) {
                                    // Um tem valor e o outro não, não bate
                                    subfieldMatch = false
                                    break
                                }
                            }

                            if (subfieldMatch) {
                                matchCount++
                            }
                        }
                    }
                }
            }

            // Se todos os campos definidos na estratégia bateram -> possível duplicado
            if (matchCount === fieldChecks.length) {
                console.log(`Potential match found with record ID: ${record.id}`)

                // Converte o formato do registo encontrado para o esperado pela função de análise
                const existingRecordData: Record<string, any> = {}
                for (const field of record.fields) {
                    if (field.fieldType === "DATA" && field.subfields) {
                        existingRecordData[field.tag] = field.subfields
                    } else if (field.fieldType === "CONTROL" && field.value) {
                        existingRecordData[field.tag] = field.value
                    }
                }

                // Chama função auxiliar para decidir se é realmente duplicado ou apenas outra edição
                const duplicateAnalysis = await this.isDuplicateOrDifferentEdition(fieldValues, existingRecordData, strategy)

                if (duplicateAnalysis.isDuplicate) {
                    console.log(`Strategy "${strategy.name}" confirmed duplicate: ${duplicateAnalysis.reason}`)
                    return { isDuplicate: true, existingRecord: record }
                } else {
                    console.log(`Strategy "${strategy.name}" detected different edition: ${duplicateAnalysis.reason}`)
                    // Continua a verificar outros registos
                }
            }
        }

        // Se nenhum registo correspondeu completamente, não há duplicados
        console.log(`Strategy "${strategy.name}" found no duplicates`)
        return { isDuplicate: false }
    }

    /**
     * Salva um registro UNIMARC na base de dados
     */
    async saveRecord(data: SaveRecordData): Promise<string> {
        try {
            const { templateId, templateName, templateDesc, textUnimarc, template, fields } = data

            // Antes de salvar, verifica se já existe um registo duplicado para evitar redundância no catálogo
            // Esta validação é fundamental para manter a integridade e evitar registos repetidos
            const duplicateCheck = await this.checkDuplicateRecord(fields, templateName)
            if (duplicateCheck.isDuplicate) {
                // Caso seja duplicado, extraímos informações úteis
                const existingRecord = duplicateCheck.existingRecord
                const existingTitle =
                    existingRecord?.fields?.find((f: any) => f.tag === "200")?.subfields?.a || "Título não encontrado"
                const existingResponsible =
                    existingRecord?.fields?.find((f: any) => f.tag === "700")?.subfields?.a || "Responsável não encontrado"

                // Lançamos uma excepção que contem dados suficientes para o utilizador perceber o conflito
                throw new Error(
                    `Registro duplicado encontrado! Já existe um registro com título "${existingTitle}" e responsável "${existingResponsible}". ID do registro existente: ${existingRecord.id}`,
                )
            }

            // Converte os campos recebidos para o formato esperado pelo Prisma antes de os inserir
            const fieldsInput = this.prepareFieldsForPrisma(data.fields, template)

            // Cria o registro principal na base de dados (catalogRecord) juntamente com os campos
            const catalogRecord = await prisma.catalogRecord.create({
                data: {
                    templateName,
                    templateDesc: templateDesc || `Registro ${templateName}`,   // Se não houver descrição, cria um padrão
                    recordTemplateId: templateId,
                    textUnimarc,
                    fields: {
                        create: fieldsInput,
                    },
                },
                include: {
                    fields: true,   // Inclui os campos para uso posterior (associações com pessoas e editores)
                },
            })

            // === Processamento de Pessoas ===
            // Definimos as tags que potencialmente representam pessoas no UNIMARC (ex: 700 - autor principal)
            const potentialPersonFields = [
                "700",
                "701",
                "702",
                // Mais tags podem ser adicionadas futuramente
            ]

            for (const field of fields) {
                // Ignora campos que não são de pessoas
                if (!potentialPersonFields.includes(field.tag)) {
                    continue
                }

                let personName: string | undefined

                if (field.fieldType === FieldType.DATA && field.subfields) {
                    // Para campos de dados, extrai subcampos relevantes
                    const subfieldsObj = field.subfields as Record<string, any>
                    const nameParts: string[] = []

                    if (subfieldsObj.a) {
                        // Extrai a parte principal do nome
                        if (Array.isArray(subfieldsObj.a)) {
                            nameParts.push(String(subfieldsObj.a[0]).trim())
                        } else if (typeof subfieldsObj.a === "string") {
                            nameParts.push(subfieldsObj.a.trim())
                        }
                    }
                    if (subfieldsObj.b) {
                        // Extrai a parte complementar do nome
                        if (Array.isArray(subfieldsObj.b)) {
                            nameParts.push(String(subfieldsObj.b[0]).trim())
                        } else if (typeof subfieldsObj.b === "string") {
                            nameParts.push(subfieldsObj.b.trim())
                        }
                    }
                    // Monta o nome completo e remove vírgulas e espaços extra
                    personName = nameParts
                        .join(" ")
                        .replace(/,(\s*),/g, ",")
                        .replace(/,$/, "")
                        .trim()

                    // Caso ainda termine com vírgula, remove
                    if (personName.endsWith(",")) {
                        personName = personName.slice(0, -1).trim()
                    }
                } else if (field.fieldType === FieldType.CONTROL && field.value) {
                    // Para campos de controlo (mais raros para pessoas), usamos o valor diretamente
                    personName = field.value.trim()
                }

                if (personName) {
                    // Utiliza IA para inferir o papel das pessoas
                    const role = await this.inferPersonRole(field.tag, field.fieldName || null)

                    // Cria ou atualiza a pessoa na base de dados
                    const person = await prisma.person.upsert({
                        where: { name: personName },
                        update: {
                            type: PersonRole.OTHER, // Valor genérico por agora; pode ser refinado com lógica mais avançada
                        },
                        create: {
                            name: personName,
                            type: role,
                        },
                    })

                    // Associa a pessoa ao registo na tabela de junção
                    await prisma.recordPerson.upsert({
                        where: {
                            recordId_personId_role: {
                                recordId: catalogRecord.id,
                                personId: person.id,
                                role: role,
                            },
                        },
                        update: {},
                        create: {
                            recordId: catalogRecord.id,
                            personId: person.id,
                            role: role,
                        },
                    })
                }
            }

            // === Processamento de Editoras ===
            const potentialPublisherFields = ["210"]    // Tag que representa dados de publicação.

            for (const field of fields) {
                if (!potentialPublisherFields.includes(field.tag)) {
                    continue
                }

                let publisherName: string | undefined

                if (field.fieldType === FieldType.DATA && field.subfields) {
                    const subfieldsObj = field.subfields as Record<string, any>
                    // Subcampo 'c' contém o nome do editor/produtor/distribuidor
                    if (subfieldsObj.c) {
                        if (Array.isArray(subfieldsObj.c)) {
                            publisherName = String(subfieldsObj.c[0].trim())
                        } else if (typeof subfieldsObj.c === "string") {
                            publisherName = subfieldsObj.c.trim()
                        }
                    }
                }

                if (publisherName) {
                    // Cria ou atualiza a editora
                    const publisher = await prisma.publisher.upsert({
                        where: { name: publisherName },
                        update: {},
                        create: {
                            name: publisherName,
                        },
                    })

                    // Associa a editora ao registo na tabela de junção
                    await prisma.recordPublisher.upsert({
                        where: {
                            recordId_publisherId: {
                                recordId: catalogRecord.id,
                                publisherId: publisher.id,
                            },
                        },
                        update: {},
                        create: {
                            recordId: catalogRecord.id,
                            publisherId: publisher.id,
                        },
                    })
                }
            }

            // Registo guardado com sucesso
            console.log(`Novo registro criado com sucesso: ID ${catalogRecord.id}`)
            return catalogRecord.id

        } catch (error) {
            // Captura qualquer erro e relança-o para ser tratado pela camada superior (ex: rota da API)
            console.error("Erro ao salvar registro:", error)
            throw error
        }
    }

    /**
     * Busca autores e o número de registos associados a cada um
     * Esta função consulta a tabela 'person' e filtra pelos tipos
     * AUTHOR ou OTHER e conta quantos registos ('CatalogRecord')
     * cada autor possui através da relação 'RecordPerson'
     * @param fields 
     * @param template 
     * @returns 
     */
    async getAuthorsWithRecordCount() {
        try {
            const authors = await prisma.person.findMany({
                where: {
                    // Utiliza o operador in para permitir múltiplos tipos de pessoa
                    // Filtra apenas por tipos relevantes podendo expandir no futuro
                    type: {
                        in: [PersonRole.AUTHOR, PersonRole.OTHER],
                    },
                },
                include: {
                    RecordPerson: {
                        // Inclui a relação com a tabela de junção `RecordPerson`
                        // apenas com o `recordId` (pois não precisamos de mais detalhes aqui).
                        select: {
                            recordId: true,
                        },
                    },
                },
                orderBy: {
                    // Ordena os autores por nome em ordem alfabética ascendente.
                    name: "asc"
                },
            })

            // Transforma o resultado: para cada autor, devolve id, nome e contagem de registros.
            return authors.map((author) => ({
                id: author.id,
                name: author.name,
                recordCount: author.RecordPerson.length,    // Usa o tamanho do array para contar registros associados.
            }))
        } catch (error) {
            // Captura e loga qualquer erro que ocorra na query ou mapeamento.
            console.error("Erro ao buscar autores com contagem de registos:", error)
            // Lança um erro genérico para a camada superior, evitando expor detalhes de DB.
            throw new Error("Falha ao buscar autores com contagem de registos")
        }
    }

    /**
     * Prepara um array de objetos de campos (CatalogField) no formato
     * esperado pelo Prisma para inserção num CatalogRecord
     * @param fields 
     * @param template 
     * @returns 
     */
    private prepareFieldsForPrisma(
        fields: SaveRecordData['fields'],
        template: Template
    ): Prisma.CatalogFieldCreateWithoutRecordInput[] {
        return fields.map(field => {
            // Procura a definição completa do campo (control ou data field)
            // dentro do template, para extrair metadados como repetibilidade e obrigatoriedade
            const fieldDef = [
                ...template.controlFields,
                ...template.dataFields
            ].find(f => f.tag === field.tag);

            return {
                tag: field.tag,     // Código do campo UNIMARC
                value: field.value ?? '',       // Valor de campo de controlo (string simples)
                subfields: field.subfields ?? Prisma.JsonNull,      // Subcampos (para campos de dados)
                fieldType: field.fieldType,     // Tipo do campo (CONTROL ou DATA)
                fieldName: field.fieldName ?? null,     // Nome amigável do campo, se existir
                subfieldNames: field.subfieldNames ?? Prisma.JsonNull,      // Nomes amigáveis dos subcampos
                isRepeatable: fieldDef?.repeatable || false,    // Define se o campo pode se repetir
                isMandatory: fieldDef?.mandatory || false       // Define se o campo é obrigatório
            };
        });
    }


    /**
     * Prepara os campos para inserção na base de dados
     * Esta função recebe os campos preenchidos (filledFields) e o template
     * de definição (template), e retorna um array de objetos prontos
     * para serem inseridos via Prisma
     */
    private prepareFields(filledFields: Record<string, any>, template: Template) {
        // Array que armazena todos os campos prontos para criação na BD
        const fieldsToCreate = [];

        // Percorre todos os pares vindos do objeto filledFields
        for (const [tag, value] of Object.entries(filledFields)) {

            // Procura no template se essa tag corresponde a um campo de controlo
            const controlField = template.controlFields.find((f) => f.tag === tag);

            // Procura no template se essa tag corresponde a um campo de dados
            const dataField = template.dataFields.find((f) => f.tag === tag);

            if (controlField) {
                // Caso seja um campo de controlo:
                // Estes campos geralmente contêm valores fixos ou identificadores
                // e não possuem subcampos
                fieldsToCreate.push({
                    tag,
                    value: String(value),
                    subfields: {},
                    fieldType: "CONTROL" as const,
                    isRepeatable: controlField.repeatable || false,
                    isMandatory: controlField.mandatory || false
                });
            } else if (dataField) {
                // Caso seja um campo de dados:
                // Estes podem conter subcampos

                // Faz o aprsing do valor para ssubcampos, utilizando a lógica definida em parseSubfields
                const subfields = this.parseSubfields(value, dataField);

                fieldsToCreate.push({
                    tag,
                    value: String(value),
                    subfields,
                    fieldType: "DATA" as const,
                    isRepeatable: dataField.repeatable || false,
                    isMandatory: dataField.mandatory || false
                });
            }
        }

        // Retorna todos os campos prontos para inserção na base de dados
        return fieldsToCreate;
    }

    /**
     * Analisa e estrutura subcampos para campos de dados.
     * 
     * Objetivo:
     * - Converter o valor bruto (`value`) associado a um campo UNIMARC
     * em uma estrutura padronizada de subcampos que pode ser guardada na base de dados.
     * - Lidar tanto com valores simples (um único conjunto de subcampos)
     * quanto com valores múltiplos (campos repetidos).
     * @param value Valor bruto do campo (pode ser objeto, string, ou array de ocorrências).
     * @param dataField Definição do campo no template, contendo metadados como tags e subcampos permitidos.
     * @returns Objeto representando os subcampos já estruturados.
     */
    private parseSubfields(value: any, dataField: DataField): Record<string, any> {

        // Caso o valor seja um array:
        // Isso implica que o campo é repetível e que o utilizador forneceu
        // múltiplas ocorrências desse mesmo campo
        if (Array.isArray(value)) {
            return {
                // occurrences guarda um array, onde cada elemento é o resultado do parsing
                // individual de cada ocorrência utilizando parseSingleSubfield
                occurrences: value.map(v => this.parseSingleSubfield(v, dataField))
            };
        }

        // Caso contrário, o valor representa apenas uma ocorrência do campo
        // Chamamos parseSingleSubfield diretamente para processar e validar
        return this.parseSingleSubfield(value, dataField);
    }

    /**
     * Analisa um único valor e o converte em um objeto de subcampos,
     * validando contra a definição do campo (`dataField`).
     * 
     * Regras principais:
     * 1. Se o valor for string simples → colocar no subcampo "a" (subcampo principal).
     * 2. Se for um objeto → validar códigos de subcampo com base na definição.
     * 3. Se nada válido for encontrado → forçar para "a" como fallback.
     * 
     * @param value Valor bruto fornecido (string simples, objeto ou outro tipo).
     * @param dataField Definição do campo de dados, contendo lista de subcampos permitidos.
     * @returns Objeto { códigoSubcampo: valor } pronto para ser persistido.
     */
    private parseSingleSubfield(value: any, dataField: DataField): Record<string, string> {
        // Objeto que armazenará o resultado final de subcampos válidos
        const subfields: Record<string, string> = {};

        // Caso 1: Valor simples (string) → atribui direto ao subcampo "a"
        // Isso é comum em campos UNIMARC onde o subcampo 'a' é o principal
        if (typeof value === "string") {
            subfields.a = value;
            return subfields;   // Já podemos retornar pois não há parsing extra a fazer
        }

        // Caso 2: Valor é um objeto (possivelmente com múltiplos subcampos)
        if (typeof value === "object" && value !== null) {
            // Percorre cada par (código, valor) do objeto recebido
            for (const [code, subfieldValue] of Object.entries(value)) {
                // Verifica se o código de subcampo existe na definição oficial do campo
                const subfieldDef = dataField.subFieldDef.find((sf) => sf.code === code);

                // Apenas aceita se o código for válido e o valor for string
                if (subfieldDef && typeof subfieldValue === "string") {
                    subfields[code] = subfieldValue;
                }
            }
        }

        // Caso 3: Nenhum subcampo válido encontrado → fallback para 'a'
        // Isso garante que o dado não se perca mesmo que venha mal formatado
        if (Object.keys(subfields).length === 0) {
            subfields.a = String(value);    // Converte para string caso seja número, boolean, etc.
        }

        // Retorna o objeto de subcampos formatado e validado
        return subfields;
    }

    /**
     * Busca um registro de catálogo pelo seu ID único
     * @param id Identificador do registro no banco
     * @returns Objeto CatalogRecord encontrado (ou null se não existir)
     */
    async getRecord(id: string) {
        try {
            // Consulta única (findUnique) no Prisma, filtrando pelo campo 'id'
            // Inclui também os campos relacionados, ordenados pelo código da tag (ascendente)
            return await prisma.catalogRecord.findUnique({
                where: { id },
                include: {
                    fields: {
                        orderBy: { tag: "asc" },    // Organização por tag facilita exibição sequencial
                    },
                },
            })
        } catch (error) {
            // Captura e loga o erro antes de repassá-lo
            console.error("Erro ao buscar registro:", error)
            // Dispara erro genérico para não expor detalhes internos ao chamador
            throw new Error("Falha ao buscar registro")
        }
    }

    /**
     * Lista registros de catálogo com suporte a paginação
     * @param page Número da página (1 por padrão)
     * @param limit Quantidade de registros por página (20 por padrão)
     * @returns { records, total, pages, currentPage }
     */
    async listRecords(page = 1, limit = 20) {
        try {
            // Calcula quantos registros devem ser "pulados" no offset
            const skip = (page - 1) * limit

            // Busca registros e total de forma paralela com Promise.all
            // → Evita duas idas ao banco em sequência
            const [records, total] = await Promise.all([
                prisma.catalogRecord.findMany({
                    skip,   // Offset baseado na página
                    take: limit,    // Quantidade por página
                    orderBy: { createdAt: "desc" }, // Mais recentes primeiro
                    include: {
                        fields: {
                            select: {
                                tag: true,
                                value: true,
                                fieldType: true,
                                fieldName: true,
                                subfields: true,
                            },
                        },
                    },
                }),
                prisma.catalogRecord.count(),   // Conta total de registros para calcular paginação
            ])

            // Retorna dados estruturados para paginação
            return {
                records,    // Lista da página atual
                total,  // Total geral de registros
                pages: Math.ceil(total / limit),    // Quantidade total de páginas
                currentPage: page,  // Página solicitada
            }
        } catch (error) {
            // Log para debug
            console.error("Erro ao listar registros:", error)
            // Mensagem genérica para o consumidor
            throw new Error("Falha ao listar registros")
        }
    }

    /**
     * Atualiza um registro existente no catálogo
     * @param id ID do registro que será atualizado
     * @param filledFields Objeto contendo os campos preenchidos (tag → valor/subcampos)
     * @param template Estrutura de template que define campos, subcampos, obrigatoriedade etc.
     */
    async updateRecord(id: string, filledFields: Record<string, any>, template: Template) {
        try {
            // Passo 1: Remove todos os campos existentes do registro
            // → Estratégia simples: apaga tudo e insere de novo (pode ser otimizada para updates parciais)
            await prisma.catalogField.deleteMany({
                where: { recordId: id },
            })

            // Passo 2: Prepara os novos campos para inserção
            // → Método 'prepareFields' transforma os dados brutos em estrutura compatível com o modelo Prisma
            const fieldsToCreate = this.prepareFields(filledFields, template)

            // Passo 3: Atualiza o registro no banco
            // - Atualiza a data de modificação (updatedAt)
            // - Cria os novos campos associados (relation create)
            await prisma.catalogRecord.update({
                where: { id },
                data: {
                    updatedAt: new Date(),
                    fields: {
                        create: fieldsToCreate,
                    },
                },
            })

            // Retorna ID atualizado como confirmação
            return id
        } catch (error) {
            // Log de detalhes na consola para debug
            console.error("Erro ao atualizar registro:", error)
            // Dispara erro genérico
            throw new Error("Falha ao atualizar registro")
        }
    }

    /**
     * Remove um registo do catálogo
     * @param id ID do registro a ser removido
     */
    async deleteRecord(id: string) {
        try {
            // Remove o registo pelo ID
            // Dependendo do schema, campos relacionados podem ser removidos em cascata (via onDelete CASCADE)
            await prisma.catalogRecord.delete({
                where: { id },
            })
        } catch (error) {
            // Log para debug
            console.error("Erro ao remover registro:", error)
            // Erro genérico para evitar exposição de detalhes da BD
            throw new Error("Falha ao remover registro")
        }
    }

    /**
     * Busca registos por template específico
     * @param templateId ID do template cujos registos devem ser retornados
     */
    async getRecordsByTemplate(templateId: string) {
        try {
            // Consulta ao banco usando Prisma
            // - 'where' filtra apenas registos cujo recordTemplateId corresponda ao recebido
            // - 'include' carrega também os campos relacionados (fields)
            // - 'orderBy' ordena os resultados do mais recente para o mais antigo
            return await prisma.catalogRecord.findMany({
                where: { recordTemplateId: templateId },
                include: {
                    fields: true,   // Inclui todos os campos associados ao registo
                },
                orderBy: { createdAt: "desc" }, // Últimos registos criados vêm primeiro
            })
        } catch (error) {
            // Log para debug
            console.error("Erro ao buscar registros por template:", error)
            // Lannça erro genérico
            throw new Error("Falha ao buscar registros por template")
        }
    }

    /**
     * Estatísticas da base de dados
     * Retorna informações resumidas sobre os registos do catálogo.
     */
    async getStats() {
        try {
            // Executa três queries em paralelo para melhorar a performance usando Promise.all
            // Isso evita que cada consulta espere a anterior terminar.
            const [totalRecords, recordsByTemplate, recentRecords] = await Promise.all([

                // Conta o número total de registos no catálogo
                prisma.catalogRecord.count(),

                // Agrupa registos por templateName e conta quantos registos há em cada grupo
                prisma.catalogRecord.groupBy({
                    by: ["templateName"],   // Campo de agrupamento
                    _count: {
                        id: true,   // Coonta quantos IDs existem por template
                    },
                    orderBy: {
                        _count: {
                            id: "desc",     // Ordem do template mais usado para o menos usado
                        },
                    },
                }),

                // Conta quantos registos foram criados nas últimas 23 horas
                prisma.catalogRecord.count({
                    where: {
                        createdAt: {
                            // 'gte' significa "maior ou igual a"
                            // Aqui calcula-se a data/hora de 24h atrás a partir de agora
                            gte: new Date(Date.now() - 24 * 60 * 60 * 1000),
                        },
                    },
                }),
            ])

            // Retorna os dados estatísticos como um objeto estruturado
            return {
                totalRecords,
                recordsByTemplate,
                recentRecords,
            }
        } catch (error) {
            // Log para debug
            console.error("Erro ao buscar estatísticas:", error)
            // Lança erro genérico
            throw new Error("Falha ao buscar estatísticas")
        }
    }
}

export const databaseService = new DatabaseService()