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
     * Salva um registro UNIMARC na base de dados
     */
    async saveRecord(data: SaveRecordData): Promise<string> {
        try {
            const { templateId, templateName, templateDesc, textUnimarc, template, fields } = data;

            // Prepara os campos no formato que o Prisma espera
            const fieldsInput = this.prepareFieldsForPrisma(data.fields, template);

            // Cria o registro principal
            const catalogRecord = await prisma.catalogRecord.create({
                data: {
                    templateName,
                    templateDesc: templateDesc || `Registro ${templateName}`,
                    recordTemplateId: templateId,
                    textUnimarc,
                    fields: {
                        create: fieldsInput
                    },
                },
                include: {
                    fields: true,
                },
            });

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

            const potentialPublisherFields = ["210"]    // Campo de Publicação, Distribuição, etc

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
                        update: {},     // Nenhuma atualização específica necessária se já existir
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
                        update: {},     // Nenhuma atualização necessária se já existir
                        create: {
                            recordId: catalogRecord.id,
                            publisherId: publisher.id,
                        },
                    })
                }
            }

            return catalogRecord.id;
        } catch (error) {
            console.error("Erro ao salvar registro:", error);
            throw new Error("Falha ao salvar registro na base de dados");
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