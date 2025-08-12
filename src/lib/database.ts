import { FieldType, PersonRole, Prisma } from "@prisma/client"
import { prisma } from "./prisma"
import type { Template, DataField } from "@/app/types/unimarc"
import { JsonValue } from "@prisma/client/runtime/library"
import OpenAI from "openai"

// Inicializar o cliente OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPEN_API_KEY,
})

export interface SaveRecordData {
    templateId: string
    templateName: string
    templateDesc?: string
    filledFields: Record<string, any>
    template: Template
    textUnimarc: string
    fields: {
        tag: string
        value?: string | null
        subfields?: JsonValue
        fieldType: FieldType
        fieldName?: string | null
        subfieldNames?: JsonValue
        isRepeatable?: boolean
    }[]
}

export class DatabaseService {

    // Função para inferir o PersonRole utilizando OpenAI
    private async inferPersonRole(fieldTag: string, fieldName: string | null): Promise<PersonRole> {
        const prompt = `Given the UNIMARC field tag "${fieldTag}" and its name "${fieldName || "N/A"}",
        what is the most appropriate role for a person associated with this field?
        Choose one from the following roles: AUTHOR, TRANSLATOR, COMPOSER, INTERPRETER, ILLUSTRATOR, EDITOR, OTHER.
        Return only the role name, e.g., "AUTHOR".`

        try {
            const completion = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: [
                    { role: "system", content: "You are a helpful assistant that infers person roles from UNIMARC fields." },
                    { role: "user", content: prompt },
                ],
                temperature: 0.1,
                max_tokens: 20,
            })

            const inferredRole = completion.choices[0]?.message?.content?.trim().toUpperCase() || ""
            if (Object.values(PersonRole).includes(inferredRole as PersonRole)) {
                return inferredRole as PersonRole
            } else {
                console.warn(`OpenAI returned an invalid role: ${inferredRole} for tag ${fieldTag}. Defaulting to OTHER.`)
                return PersonRole.OTHER
            }
        } catch (error) {
            console.error(`Error inferring person role for tag ${fieldTag}:`, error)
            return PersonRole.OTHER
        }
    }

    /**
     * Verifica se um registo já exise na base de dados baseado em campos únicos
     * Adapta-se ao tipo de template/ material
     */

    private async checkDuplicateRecord(
        fields: SaveRecordData["fields"],
        templateName: string,
    ): Promise<{ isDuplicate: boolean; existingRecord?: any }> {
        try {
            console.log(`=== CHECKING DUPLICATES FOR TEMPLATE: ${templateName} ===`)

            // Definir estratégias de verificação por tipo de material
            const duplicateStrategies = this.getDuplicateStrategies(templateName.toLowerCase())

            console.log(`Template: ${templateName}`)
            console.log(`Strategies: ${duplicateStrategies.map((s) => s.name).join(", ")}`)

            // Extrair valores dos campos relevantes
            const fieldValues = this.extractFieldValues(fields)
            console.log(`Extracted field values:`, fieldValues)

            // Tentar cada estratégia em ordem de prioridade
            for (const strategy of duplicateStrategies) {
                console.log(`\n--- Trying strategy: ${strategy.name} ---`)
                const result = await this.checkDuplicateByStrategy(strategy, fieldValues)
                if (result.isDuplicate) {
                    console.log(`✅ DUPLICATE FOUND using strategy: ${strategy.name}`)
                    return result
                } else {
                    console.log(`❌ No duplicate found with strategy: ${strategy.name}`)
                }
            }

            console.log(`=== NO DUPLICATES FOUND FOR ANY STRATEGY ===`)
            return { isDuplicate: false }
        } catch (error) {
            console.error("Erro ao verificar duplicados:", error)
            // Em caso de erro, não bloquear a gravação
            return { isDuplicate: false }
        }
    }

    /**
     * Define estratégias de verificação de duplicados por tipo de material
     */

    private getDuplicateStrategies(templateName: string) {
        const strategies = []

        switch (templateName) {
            case "book (monograph)":
                strategies.push(
                    // ISBN é sempre único - se for igual, é realmente duplicado
                    { name: "ISBN", fields: ["010"], subfields: ["a"], priority: 1 },
                    // Título + Autor + Ano + Editora - muito específico
                    {
                        name: "Título+Autor+Ano+Editora",
                        fields: ["200", "700", "210", "210"],
                        subfields: ["a", "a,b", "d", "c"],
                        priority: 2,
                    },
                    // Título + Autor + ISBN parcial (para detectar mesmo livro com ISBNs similares)
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
                // Estratégia genérica mais específica
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

        return strategies.sort((a, b) => a.priority - b.priority)
    }

    /**
   * Verifica se dois registros são realmente duplicados ou apenas edições diferentes
   */
    private async isDuplicateOrDifferentEdition(
        newRecord: Record<string, any>,
        existingRecord: any,
        strategy: any,
    ): Promise<{ isDuplicate: boolean; reason?: string }> {
        console.log(`\n=== ANALYZING IF RECORDS ARE DUPLICATES OR DIFFERENT EDITIONS ===`)

        // Se a estratégia é ISBN e os ISBNs são idênticos, é duplicado
        if (strategy.name === "ISBN") {
            console.log("ISBN match - this is a true duplicate")
            return { isDuplicate: true, reason: "ISBN idêntico" }
        }

        // Para outras estratégias, verificar diferenças que indicam edições diferentes
        const differences = []

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

        console.log(`Differences found: ${differences.length}`)
        differences.forEach((diff) => console.log(`  - ${diff}`))

        // Se há pelo menos 2 diferenças significativas, provavelmente são edições diferentes
        if (differences.length >= 2) {
            console.log("✅ DIFFERENT EDITIONS - allowing new record")
            return {
                isDuplicate: false,
                reason: `Edições diferentes: ${differences.join(", ")}`,
            }
        }

        // Se há apenas 1 diferença ou nenhuma, pode ser duplicado
        if (differences.length <= 1) {
            console.log("❌ LIKELY DUPLICATE - blocking new record")
            return {
                isDuplicate: true,
                reason: differences.length === 1 ? `Possível duplicado: ${differences[0]}` : "Registros idênticos",
            }
        }

        return { isDuplicate: false }
    }

    // Funções auxiliares para extrair informações específicas
    private extractYear(record: any): string | null {
        if (record["210"] && record["210"].d) {
            const year = String(record["210"].d).match(/\d{4}/)
            return year ? year[0] : null
        }
        return null
    }

    private extractPublisher(record: any): string | null {
        if (record["210"] && record["210"].c) {
            return String(record["210"].c).trim()
        }
        return null
    }

    private extractISBN(record: any): string | null {
        if (record["010"] && record["010"].a) {
            return String(record["010"].a).replace(/[-\s]/g, "").trim()
        }
        return null
    }

    private extractEdition(record: any): string | null {
        if (record["205"] && record["205"].a) {
            return String(record["205"].a).trim()
        }
        return null
    }

    /**
     * Extrai valores dos campos para verificação de duplicados
     */

    private extractFieldValues(fields: SaveRecordData["fields"]): Record<string, any> {
        const values: Record<string, any> = {}

        for (const field of fields) {
            if (field.fieldType === FieldType.DATA && field.subfields) {
                const subfieldsObj = field.subfields as Record<string, any>
                values[field.tag] = subfieldsObj
            } else if (field.fieldType === FieldType.CONTROL && field.value) {
                values[field.tag] = field.value
            }
        }

        return values
    }

    /**
     * Verifica duplicados utilizando uma estratégia específica
     */

    private async checkDuplicateByStrategy(
        strategy: any,
        fieldValues: Record<string, any>,
    ): Promise<{ isDuplicate: boolean; existingRecord?: any }> {
        console.log(`Checking strategy: ${strategy.name}`)
        console.log(`Available field values:`, Object.keys(fieldValues))

        // Para estratégias simples como ISBN, usar busca direta
        if (strategy.name === "ISBN" && fieldValues["010"]) {
            const isbn = fieldValues["010"].a
            if (isbn) {
                const cleanISBN = String(isbn).replace(/[-\s]/g, "").trim()

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
                                    in: strategy.fields,
                                },
                            },
                        },
                    },
                })

                if (existingRecord) {
                    console.log(`ISBN duplicate found: ${cleanISBN}`)
                    return { isDuplicate: true, existingRecord }
                }
            }
        }

        // Para outras estratégias, usar busca por múltiplos campos
        const extractedValues = []
        const fieldChecks = []

        for (let i = 0; i < strategy.fields.length; i++) {
            const fieldTag = strategy.fields[i]
            const subfieldCodes = strategy.subfields[i].split(",")

            if (!fieldValues[fieldTag]) continue

            let value = ""

            if (fieldTag.startsWith("0")) {
                // Campo de controle
                value = String(fieldValues[fieldTag]).trim()
            } else {
                // Campo de dados - extrair subcampos
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

                value = parts
                    .join(" ")
                    .replace(/,(\s*),/g, ",")
                    .replace(/,$/, "")
                    .trim()
                if (value.endsWith(",")) {
                    value = value.slice(0, -1).trim()
                }
            }

            if (value && (!strategy.minLength || value.length >= strategy.minLength)) {
                extractedValues.push(value)
                fieldChecks.push({ tag: fieldTag, value, subfieldCodes })
            }
        }

        if (fieldChecks.length === 0) {
            console.log(`No valid fields found for strategy ${strategy.name}`)
            return { isDuplicate: false }
        }

        // Buscar todos os registros que tenham pelo menos um dos campos
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
                            in: ["010", "200", "205", "210", "700"], // Incluir campos relevantes para análise
                        },
                    },
                },
            },
        })

        // Verificar manualmente se algum registro coincide com todos os critérios
        for (const record of allRecords) {
            let matchCount = 0

            for (const check of fieldChecks) {
                const recordField = record.fields.find((f) => f.tag === check.tag)

                if (recordField) {
                    if (check.tag.startsWith("0")) {
                        // Campo de controle
                        if (recordField.value === check.value) {
                            matchCount++
                        }
                    } else {
                        // Campo de dados
                        const recordSubfields = recordField.subfields as any
                        if (recordSubfields) {
                            let subfieldMatch = true

                            for (const code of check.subfieldCodes) {
                                const expectedValue = fieldValues[check.tag][code]
                                const recordValue = recordSubfields[code]

                                if (expectedValue && recordValue) {
                                    const cleanExpected = String(expectedValue).replace(/,$/, "").trim()
                                    const cleanRecord = String(recordValue).replace(/,$/, "").trim()

                                    if (cleanExpected !== cleanRecord) {
                                        subfieldMatch = false
                                        break
                                    }
                                } else if (expectedValue || recordValue) {
                                    // Um tem valor e outro não
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

            // Se todos os campos coincidem, verificar se é duplicado ou edição diferente
            if (matchCount === fieldChecks.length) {
                console.log(`Potential match found with record ID: ${record.id}`)

                // Converter record.fields para o formato esperado
                const existingRecordData: Record<string, any> = {}
                for (const field of record.fields) {
                    if (field.fieldType === "DATA" && field.subfields) {
                        existingRecordData[field.tag] = field.subfields
                    } else if (field.fieldType === "CONTROL" && field.value) {
                        existingRecordData[field.tag] = field.value
                    }
                }

                const duplicateAnalysis = await this.isDuplicateOrDifferentEdition(fieldValues, existingRecordData, strategy)

                if (duplicateAnalysis.isDuplicate) {
                    console.log(`Strategy "${strategy.name}" confirmed duplicate: ${duplicateAnalysis.reason}`)
                    return { isDuplicate: true, existingRecord: record }
                } else {
                    console.log(`Strategy "${strategy.name}" detected different edition: ${duplicateAnalysis.reason}`)
                    // Continue checking other records
                }
            }
        }

        console.log(`Strategy "${strategy.name}" found no duplicates`)
        return { isDuplicate: false }
    }

    /**
     * Salva um registro UNIMARC na base de dados
     */
    async saveRecord(data: SaveRecordData): Promise<string> {
        try {
            const { templateId, templateName, templateDesc, textUnimarc, template, fields } = data

            // NOVO: Verificar se o registro já existe (passar templateName)
            const duplicateCheck = await this.checkDuplicateRecord(fields, templateName)
            if (duplicateCheck.isDuplicate) {
                const existingRecord = duplicateCheck.existingRecord
                const existingTitle =
                    existingRecord?.fields?.find((f: any) => f.tag === "200")?.subfields?.a || "Título não encontrado"
                const existingResponsible =
                    existingRecord?.fields?.find((f: any) => f.tag === "700")?.subfields?.a || "Responsável não encontrado"

                throw new Error(
                    `Registro duplicado encontrado! Já existe um registro com título "${existingTitle}" e responsável "${existingResponsible}". ID do registro existente: ${existingRecord.id}`,
                )
            }

            // Prepara os campos no formato que o Prisma espera
            const fieldsInput = this.prepareFieldsForPrisma(data.fields, template)

            // Cria o registro principal
            const catalogRecord = await prisma.catalogRecord.create({
                data: {
                    templateName,
                    templateDesc: templateDesc || `Registro ${templateName}`,
                    recordTemplateId: templateId,
                    textUnimarc,
                    fields: {
                        create: fieldsInput,
                    },
                },
                include: {
                    fields: true,
                },
            })

            // Processar pessoas dos 'fields' e ligá-las
            // Identificar campos que podem conter pessoas (ex: 7xx)
            const potentialPersonFields = [
                "700",
                "701",
                "702",
                // Adicionar mais tags que representam pessoas
            ]

            for (const field of fields) {
                // Iterar sobre os RecordField[]
                if (!potentialPersonFields.includes(field.tag)) {
                    continue // Ignorar se não for um campo de pessoa potencial
                }

                let personName: string | undefined

                if (field.fieldType === FieldType.DATA && field.subfields) {
                    const subfieldsObj = field.subfields as Record<string, any>
                    // Lógica aprimorada para extrair o nome completo de campos de dados como 700
                    const nameParts: string[] = []
                    if (subfieldsObj.a) {
                        // Subcampo $a (entrada principal, ex: Tordo,)
                        if (Array.isArray(subfieldsObj.a)) {
                            nameParts.push(String(subfieldsObj.a[0]).trim())
                        } else if (typeof subfieldsObj.a === "string") {
                            nameParts.push(subfieldsObj.a.trim())
                        }
                    }
                    if (subfieldsObj.b) {
                        // Subcampo $b (outras partes do nome, ex: João)
                        if (Array.isArray(subfieldsObj.b)) {
                            nameParts.push(String(subfieldsObj.b[0]).trim())
                        } else if (typeof subfieldsObj.b === "string") {
                            nameParts.push(subfieldsObj.b.trim())
                        }
                    }
                    // Concatena as partes do nome, removendo vírgulas soltas e espaços extras
                    personName = nameParts
                        .join(" ")
                        .replace(/,(\s*),/g, ",")
                        .replace(/,$/, "")
                        .trim()
                    // Se o nome ainda terminar com vírgula, remove-a (ex: "Tordo,")
                    if (personName.endsWith(",")) {
                        personName = personName.slice(0, -1).trim()
                    }
                } else if (field.fieldType === FieldType.CONTROL && field.value) {
                    // Para campos de controlo, o valor é diretamente o nome (se houver algum campo de controlo de pessoa no futuro)
                    personName = field.value.trim()
                }

                if (personName) {
                    // Inferir o papel da pessoa usando OpenAI
                    const role = await this.inferPersonRole(field.tag, field.fieldName || null)

                    // Encontrar ou criar a Pessoa
                    const person = await prisma.person.upsert({
                        where: { name: personName },
                        update: {
                            // A lógica de atualização pode ser refinada. Por agora, garante que o tipo é definido.
                            type: PersonRole.OTHER, // Pode ser ajustado para ser mais inteligente
                        },
                        create: {
                            name: personName,
                            type: role,
                        },
                    })

                    // Ligar o CatalogRecord à Pessoa através da tabela de junção RecordPerson
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

            const potentialPublisherFields = ["210"] // Campo de Publicação, Distribuição, etc

            for (const field of fields) {
                if (!potentialPublisherFields.includes(field.tag)) {
                    continue
                }

                let publisherName: string | undefined

                if (field.fieldType === FieldType.DATA && field.subfields) {
                    const subfieldsObj = field.subfields as Record<string, any>
                    // O subcampo 'c' do campo 210 é o "Nome do editor, produtor e/ou distribuidor"
                    if (subfieldsObj.c) {
                        if (Array.isArray(subfieldsObj.c)) {
                            publisherName = String(subfieldsObj.c[0].trim())
                        } else if (typeof subfieldsObj.c === "string") {
                            publisherName = subfieldsObj.c.trim()
                        }
                    }
                }

                if (publisherName) {
                    // Enncontrar ou criar a Editora
                    const publisher = await prisma.publisher.upsert({
                        where: { name: publisherName },
                        update: {}, // Nenhuma atualização específica necessária se já existir
                        create: {
                            name: publisherName,
                        },
                    })

                    // Ligar o CatalogRecord à Editora através da tabela de junção RecordPublisher
                    await prisma.recordPublisher.upsert({
                        where: {
                            recordId_publisherId: {
                                recordId: catalogRecord.id,
                                publisherId: publisher.id,
                            },
                        },
                        update: {}, // Nenhuma atualização necessária se já existir
                        create: {
                            recordId: catalogRecord.id,
                            publisherId: publisher.id,
                        },
                    })
                }
            }

            console.log(`Novo registro criado com sucesso: ID ${catalogRecord.id}`)
            return catalogRecord.id
        } catch (error) {
            console.error("Erro ao salvar registro:", error)
            throw error // Re-throw para que a API route possa capturar e retornar o erro específico
        }
    }

    /**
     * Busca autores e o número de registos associados a cada um
     * @param fields 
     * @param template 
     * @returns 
     */
    async getAuthorsWithRecordCount() {
        try {
            const authors = await prisma.person.findMany({
                where: {
                    // MODIFICADO: Usar o operador 'in' para incluir múltiplos PersonRole
                    type: {
                        in: [PersonRole.AUTHOR, PersonRole.OTHER],
                    },
                },
                include: {
                    RecordPerson: {
                        // Inclui a relação com RecordPerson para contar os registros
                        select: {
                            recordId: true,
                        },
                    },
                },
                orderBy: {
                    name: "asc"
                },
            })

            return authors.map((author) => ({
                id: author.id,
                name: author.name,
                recordCount: author.RecordPerson.length,    // Conta o número de registos associados
            }))
        } catch (error) {
            console.error("Erro ao buscar autores com contagem de registos:", error)
            throw new Error("Falha ao buscar autores com contagem de registos")
        }
    }

    private prepareFieldsForPrisma(
        fields: SaveRecordData['fields'],
        template: Template
    ): Prisma.CatalogFieldCreateWithoutRecordInput[] {
        return fields.map(field => {
            // Encontra a definição do campo no template para obter informações adicionais
            const fieldDef = [
                ...template.controlFields,
                ...template.dataFields
            ].find(f => f.tag === field.tag);

            return {
                tag: field.tag,
                value: field.value ?? '',
                subfields: field.subfields ?? Prisma.JsonNull,
                fieldType: field.fieldType,
                fieldName: field.fieldName ?? null,
                subfieldNames: field.subfieldNames ?? Prisma.JsonNull,
                isRepeatable: fieldDef?.repeatable || false, // Adiciona informação de repetibilidade
                isMandatory: fieldDef?.mandatory || false    // Adiciona informação de obrigatoriedade
            };
        });
    }


    /**
     * Prepara os campos para inserção na base de dados
     */
    private prepareFields(filledFields: Record<string, any>, template: Template) {
        const fieldsToCreate = [];

        for (const [tag, value] of Object.entries(filledFields)) {
            // Encontra o campo no template
            const controlField = template.controlFields.find((f) => f.tag === tag);
            const dataField = template.dataFields.find((f) => f.tag === tag);

            if (controlField) {
                // Campo de controle
                fieldsToCreate.push({
                    tag,
                    value: String(value),
                    subfields: {},
                    fieldType: "CONTROL" as const,
                    isRepeatable: controlField.repeatable || false,
                    isMandatory: controlField.mandatory || false
                });
            } else if (dataField) {
                // Campo de dados - pode ter subcampos
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

        return fieldsToCreate;
    }

    /**
     * Analisa e estrutura subcampos para campos de dados
     */
    private parseSubfields(value: any, dataField: DataField): Record<string, any> {
        // Se o valor é um array, significa que temos múltiplas ocorrências
        if (Array.isArray(value)) {
            return {
                occurrences: value.map(v => this.parseSingleSubfield(v, dataField))
            };
        }

        return this.parseSingleSubfield(value, dataField);
    }

    private parseSingleSubfield(value: any, dataField: DataField): Record<string, string> {
        const subfields: Record<string, string> = {};

        // Se o valor é uma string simples, coloca no subcampo 'a' (principal)
        if (typeof value === "string") {
            subfields.a = value;
            return subfields;
        }

        // Se o valor já é um objeto com subcampos
        if (typeof value === "object" && value !== null) {
            // Valida se os subcampos existem na definição
            for (const [code, subfieldValue] of Object.entries(value)) {
                const subfieldDef = dataField.subFieldDef.find((sf) => sf.code === code);
                if (subfieldDef && typeof subfieldValue === "string") {
                    subfields[code] = subfieldValue;
                }
            }
        }

        // Se não há subcampos válidos, coloca no 'a'
        if (Object.keys(subfields).length === 0) {
            subfields.a = String(value);
        }

        return subfields;
    }

    /**
     * Busca um registro por ID
     */
    async getRecord(id: string) {
        try {
            return await prisma.catalogRecord.findUnique({
                where: { id },
                include: {
                    fields: {
                        orderBy: { tag: "asc" },
                    },
                },
            })
        } catch (error) {
            console.error("Erro ao buscar registro:", error)
            throw new Error("Falha ao buscar registro")
        }
    }

    /**
     * Lista registros com paginação
     */
    async listRecords(page = 1, limit = 20) {
        try {
            const skip = (page - 1) * limit

            const [records, total] = await Promise.all([
                prisma.catalogRecord.findMany({
                    skip,
                    take: limit,
                    orderBy: { createdAt: "desc" },
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
                prisma.catalogRecord.count(),
            ])

            return {
                records,
                total,
                pages: Math.ceil(total / limit),
                currentPage: page,
            }
        } catch (error) {
            console.error("Erro ao listar registros:", error)
            throw new Error("Falha ao listar registros")
        }
    }

    /**
     * Atualiza um registro existente
     */
    async updateRecord(id: string, filledFields: Record<string, any>, template: Template) {
        try {
            // Remove campos existentes
            await prisma.catalogField.deleteMany({
                where: { recordId: id },
            })

            // Adiciona novos campos
            const fieldsToCreate = this.prepareFields(filledFields, template)

            await prisma.catalogRecord.update({
                where: { id },
                data: {
                    updatedAt: new Date(),
                    fields: {
                        create: fieldsToCreate,
                    },
                },
            })

            return id
        } catch (error) {
            console.error("Erro ao atualizar registro:", error)
            throw new Error("Falha ao atualizar registro")
        }
    }

    /**
     * Remove um registro
     */
    async deleteRecord(id: string) {
        try {
            await prisma.catalogRecord.delete({
                where: { id },
            })
        } catch (error) {
            console.error("Erro ao remover registro:", error)
            throw new Error("Falha ao remover registro")
        }
    }

    /**
     * Busca registros por template
     */
    async getRecordsByTemplate(templateId: string) {
        try {
            return await prisma.catalogRecord.findMany({
                where: { recordTemplateId: templateId },
                include: {
                    fields: true,
                },
                orderBy: { createdAt: "desc" },
            })
        } catch (error) {
            console.error("Erro ao buscar registros por template:", error)
            throw new Error("Falha ao buscar registros por template")
        }
    }

    /**
     * Estatísticas da base de dados
     */
    async getStats() {
        try {
            const [totalRecords, recordsByTemplate, recentRecords] = await Promise.all([
                prisma.catalogRecord.count(),
                prisma.catalogRecord.groupBy({
                    by: ["templateName"],
                    _count: {
                        id: true,
                    },
                    orderBy: {
                        _count: {
                            id: "desc",
                        },
                    },
                }),
                prisma.catalogRecord.count({
                    where: {
                        createdAt: {
                            gte: new Date(Date.now() - 24 * 60 * 60 * 1000), // últimas 24h
                        },
                    },
                }),
            ])

            return {
                totalRecords,
                recordsByTemplate,
                recentRecords,
            }
        } catch (error) {
            console.error("Erro ao buscar estatísticas:", error)
            throw new Error("Falha ao buscar estatísticas")
        }
    }
}

export const databaseService = new DatabaseService()